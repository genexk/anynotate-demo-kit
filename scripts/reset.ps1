<#
.SYNOPSIS
  Puts the demo back to its starting state between takes.
.DESCRIPTION
  Stops the demo server, runs git reset --hard origin/main and git clean -fd in the demo clone
  (and nowhere else), starts the server again, and removes Anynotate bundles whose page URL is on
  http://localhost:5173 from the inbox and archive.
.EXAMPLE
  pwsh -File scripts/reset.ps1 -DryRun
#>
param(
  [string]$Path,
  [switch]$DryRun,
  [switch]$NoServer
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
$script:DryRun = [bool]$DryRun

$dir = if ($Path) { $Path } else { Get-DefaultDemoDir }
Assert-DemoClone $dir
$dir = (Resolve-Path -LiteralPath $dir).ProviderPath
Say "Demo clone: $dir"
if ($script:DryRun) { Say 'Dry run: nothing will be changed (git fetch still runs).' }

if (-not $NoServer) {
  if (-not (Stop-DemoServer $dir)) { Fail "free port $($script:DemoPort) first, then run reset again." }
}

& git -C $dir fetch --quiet origin main
if ($LASTEXITCODE -ne 0) { Warn 'could not fetch origin (offline?); resetting to the last fetched origin/main.' }
& git -C $dir rev-parse --verify --quiet origin/main | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "origin/main not found in $dir." }

if ($script:DryRun) {
  Say 'Would discard these changes:'
  Invoke-Git -C $dir status --short
  Invoke-Git -C $dir clean -nd
}
Invoke-Step "git -C $dir checkout main" { Invoke-Git -C $dir checkout --quiet main | Out-Null }
Invoke-Step "git -C $dir reset --hard origin/main" { Invoke-Git -C $dir reset --hard --quiet origin/main | Out-Null }
Invoke-Step "git -C $dir clean -fd" { Invoke-Git -C $dir clean -fd --quiet | Out-Null }
if (-not $script:DryRun) { Say "Demo files are back to origin/main ($(Invoke-Git -C $dir rev-parse --short origin/main))." }

if (-not $NoServer) { Start-DemoServer $dir | Out-Null }

Remove-DemoBundles
Write-ClearReminder
