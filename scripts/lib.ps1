# Shared helpers for setup.ps1, reset.ps1 and check.ps1. Dot-sourced, not run.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DemoRepoUrl = if ($env:ANYNOTATE_DEMO_REPO) { $env:ANYNOTATE_DEMO_REPO } else { 'https://github.com/genexk/anynotate-demo.git' }
$script:DemoPort = if ($env:ANYNOTATE_DEMO_PORT) { $env:ANYNOTATE_DEMO_PORT } else { '5173' }
$script:DemoUrl = "http://localhost:$($script:DemoPort)"
$script:DemoMarker = '.anynotate-demo'
$script:BundleIdRe = '^\d{4}-\d{2}-\d{2}T\d{6}-[a-z0-9-]+$'
$script:DryRun = $false

function Say([string]$Message) { Write-Host $Message }
function Warn([string]$Message) { Write-Warning $Message }
function Fail([string]$Message) { Write-Host "error: $Message" -ForegroundColor Red; exit 1 }

function Test-Windows { $PSVersionTable.PSEdition -eq 'Desktop' -or ((Test-Path variable:IsWindows) -and $IsWindows) }

function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Invoke-Step([string]$Description, [scriptblock]$Action) {
  if ($script:DryRun) { Say "[dry-run] $Description" } else { & $Action }
}

function Invoke-Git {
  $ErrorActionPreference = 'Continue'
  $out = & git @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed: $out" }
  $out | ForEach-Object { "$_" }
}

function Get-DefaultDemoDir {
  if ($env:ANYNOTATE_DEMO_DIR) { return $env:ANYNOTATE_DEMO_DIR }
  Join-Path $HOME 'anynotate-demo'
}

# Same rule as the bridge: a blank or relative ANYNOTATE_HOME is ignored.
function Get-AnynotateHome {
  $h = "$env:ANYNOTATE_HOME".Trim()
  if ($h -and [System.IO.Path]::IsPathRooted($h)) { return $h }
  Join-Path $HOME '.anynotate'
}

# True only for the top of a git clone of anynotate-demo: the committed marker file says so
# and the origin remote is named anynotate-demo.
function Test-DemoClone([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $false }
  $full = (Resolve-Path -LiteralPath $Dir).ProviderPath
  $top = & git -C $full rev-parse --show-toplevel 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $top) { return $false }
  $topFull = (Resolve-Path -LiteralPath $top).ProviderPath
  if ($topFull.TrimEnd('\', '/') -ne $full.TrimEnd('\', '/')) { return $false }
  $marker = & git -C $full show "HEAD:$($script:DemoMarker)" 2>$null
  if ($LASTEXITCODE -ne 0 -or "$marker".Trim() -ne 'anynotate-demo') { return $false }
  $url = & git -C $full remote get-url origin 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  return "$url" -match 'anynotate-demo(\.git)?[\\/]?$'
}

function Assert-DemoClone([string]$Dir) {
  if (-not (Test-DemoClone $Dir)) {
    Fail "$Dir is not a clone of anynotate-demo (needs the committed $($script:DemoMarker) marker and an origin remote ending in anynotate-demo). Nothing was changed."
  }
}

function Test-ServerUp {
  try {
    $r = Invoke-WebRequest -Uri "$($script:DemoUrl)/" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Wait-Server {
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-ServerUp) { return $true }
    Start-Sleep -Milliseconds 200
  }
  $false
}

function Get-DemoServerProcess([string]$Dir) {
  $pidFile = Join-Path $Dir '.serve.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$id)) { return $null }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -match '^(bun|python3?|py)$') { return $p }
  $null
}

function Stop-DemoServer([string]$Dir) {
  $p = Get-DemoServerProcess $Dir
  if ($p) {
    Say "Stopping the demo server (pid $($p.Id))."
    Invoke-Step "Stop-Process -Id $($p.Id)" { Stop-Process -Id $p.Id; $p.WaitForExit(5000) | Out-Null }
  }
  $pidFile = Join-Path $Dir '.serve.pid'
  if (Test-Path -LiteralPath $pidFile) { Invoke-Step "remove $pidFile" { Remove-Item -LiteralPath $pidFile -Force } }
  if (-not $script:DryRun -and (Test-ServerUp)) {
    Warn "something else is still answering on $($script:DemoUrl); it was not started by these scripts, so it was left alone."
    return $false
  }
  $true
}

function Start-DemoServer([string]$Dir) {
  if ($script:DryRun) { Say "[dry-run] start the demo server in $Dir on port $($script:DemoPort)"; return $true }
  $env:PORT = $script:DemoPort
  $log = Join-Path $Dir '.serve.log'
  $errLog = Join-Path $Dir '.serve.err.log'
  $common = @{ WorkingDirectory = $Dir; RedirectStandardOutput = $log; RedirectStandardError = $errLog; PassThru = $true }
  if (Test-Windows) { $common.WindowStyle = 'Hidden' }
  if (Test-Command 'bun') {
    $p = Start-Process -FilePath 'bun' -ArgumentList 'serve.ts' @common
  } else {
    $py = if (Test-Command 'python3') { 'python3' } elseif (Test-Command 'python') { 'python' } else { Fail 'install bun (recommended) or python to serve the demo.' }
    Warn 'bun not found: serving with python, no live reload.'
    $p = Start-Process -FilePath $py -ArgumentList '-m', 'http.server', $script:DemoPort, '--bind', '127.0.0.1', '--directory', 'site' @common
  }
  Set-Content -LiteralPath (Join-Path $Dir '.serve.pid') -Value $p.Id
  if (Wait-Server) {
    Say "Demo server running at $($script:DemoUrl)/ (pid $($p.Id), log: $log)."
    return $true
  }
  Warn "the server did not answer on $($script:DemoUrl); see $log"
  $false
}

function Test-DemoUrl([string]$Url) {
  $u = $script:DemoUrl
  $Url -eq $u -or $Url.StartsWith("$u/") -or $Url.StartsWith("$u?") -or $Url.StartsWith("$u#")
}

function Test-RealDir([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  $item -and $item.PSIsContainer -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# Bundles whose page URL is on the demo server. Only real bundle folders directly inside
# inbox/ or archive/ are considered; links and junctions are skipped.
function Get-DemoBundles {
  $home_ = Get-AnynotateHome
  foreach ($sub in 'inbox', 'archive') {
    $root = Join-Path $home_ $sub
    if (-not (Test-RealDir $root)) { continue }
    foreach ($d in Get-ChildItem -LiteralPath $root -Directory -Force) {
      if ($d.Name -notmatch $script:BundleIdRe) { continue }
      if ($d.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
      $json = Join-Path $d.FullName 'annotations.json'
      if (-not (Test-Path -LiteralPath $json -PathType Leaf)) { continue }
      try { $url = [string](Get-Content -LiteralPath $json -Raw | ConvertFrom-Json).url } catch { continue }
      if (Test-DemoUrl $url) { [pscustomobject]@{ Sub = $sub; Id = $d.Name; Path = $d.FullName } }
    }
  }
}

function Get-NewestInboxBundle([string]$Inbox) {
  Get-ChildItem -LiteralPath $Inbox -Directory -Force |
    Where-Object { $_.Name -match $script:BundleIdRe -and -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'annotations.json')) } |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
}

# Repoints inbox/latest and inbox/latest-id when they named a removed bundle.
function Update-Latest([string]$Inbox, [string[]]$Removed) {
  $idFile = Join-Path $Inbox 'latest-id'
  $link = Join-Path $Inbox 'latest'
  $current = $null
  if (Test-Path -LiteralPath $idFile) { $current = (Get-Content -LiteralPath $idFile -Raw).Trim() }
  if (-not $current -or $Removed -notcontains $current) { return }
  $newest = Get-NewestInboxBundle $Inbox
  $linkItem = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($script:DryRun) { Say "[dry-run] point inbox/latest at $(if ($newest) { $newest } else { 'nothing' })"; return }
  if ($linkItem -and $linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $linkItem.Delete() }
  if ($newest) {
    Say "Pointing inbox/latest at $newest."
    Set-Content -LiteralPath $idFile -Value $newest
    $type = if (Test-Windows) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $type -Path $link -Target (Join-Path $Inbox $newest) | Out-Null
  } else {
    Remove-Item -LiteralPath $idFile -Force
  }
}

function Remove-DemoBundles {
  $home_ = Get-AnynotateHome
  $removed = @()
  $count = 0
  foreach ($b in @(Get-DemoBundles)) {
    if (Get-ChildItem -LiteralPath $b.Path -Filter 'status.json.claim-*' -Force) {
      Warn "$($b.Sub)/$($b.Id) is being delivered right now; left alone. Run reset again in a moment."
      continue
    }
    Say "Removing demo notes $($b.Sub)/$($b.Id)"
    Invoke-Step "Remove-Item -Recurse $($b.Path)" { Remove-Item -LiteralPath $b.Path -Recurse -Force }
    if ($b.Sub -eq 'inbox') { $removed += $b.Id }
    $count++
  }
  if ($count -eq 0) { Say "No notes for $($script:DemoUrl) in $home_ (inbox or archive)." }
  elseif ($removed.Count -gt 0) { Update-Latest (Join-Path $home_ 'inbox') $removed }
}

function Write-ClearReminder {
  Say ''
  Say 'One thing the scripts cannot do: notes you saved but did not send live in the browser.'
  Say "In Chrome, open Anynotate's Options and click ""Clear all unsent notes"""
  Say "(or delete the notes for $($script:DemoUrl) in the dock)."
}
