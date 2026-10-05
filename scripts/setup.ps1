<#
.SYNOPSIS
  Clones (or updates) the demo site, checks Anynotate and starts the demo server.
.EXAMPLE
  pwsh -File scripts/setup.ps1
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

if (-not (Test-Command 'git')) { Fail 'git is required.' }
if (-not ((Test-Command 'bun') -or (Test-Command 'python3') -or (Test-Command 'python'))) { Fail 'install bun (recommended) or python to serve the demo.' }
if (-not (Test-Command 'bun')) { Warn 'bun not found: the demo will be served by python without live reload.' }

if (Test-Path -LiteralPath $dir) {
  Assert-DemoClone $dir
  Say "Updating the demo clone in $dir"
  & git -C $dir fetch --quiet origin main
  if ($LASTEXITCODE -ne 0) { Warn 'could not fetch origin (offline?).' }
  if (Invoke-Git -C $dir status --porcelain) {
    Warn 'the demo has local changes; run scripts/reset.ps1 to start from a clean page.'
  } elseif ((Invoke-Git -C $dir rev-parse --abbrev-ref HEAD) -eq 'main') {
    Invoke-Step "git -C $dir merge --ff-only origin/main" { Invoke-Git -C $dir merge --ff-only --quiet origin/main | Out-Null }
  }
} else {
  Say "Cloning $($script:DemoRepoUrl) into $dir"
  Invoke-Step "git clone $($script:DemoRepoUrl) $dir" { Invoke-Git clone --quiet --branch main $script:DemoRepoUrl $dir | Out-Null }
}
if (Test-Path -LiteralPath $dir) { $dir = (Resolve-Path -LiteralPath $dir).ProviderPath }

if (Test-Command 'anynotate') {
  Say 'Running anynotate doctor'
  & anynotate doctor
  if ($LASTEXITCODE -ne 0) { Warn 'anynotate doctor reported a problem; fix it before recording.' }
} else {
  Warn 'anynotate is not on PATH; install it first (see https://github.com/genexk/anynotate).'
}

if (-not $NoServer) {
  if ((Get-DemoServerProcess $dir) -and (Test-ServerUp)) {
    Say "Demo server already running at $($script:DemoUrl)/."
  } elseif (Test-ServerUp) {
    Warn "something else is answering on $($script:DemoUrl); stop it or set ANYNOTATE_DEMO_PORT."
  } else {
    Start-DemoServer $dir | Out-Null
  }
}

Say ''
Say 'Ready.'
Say "  Page:          $($script:DemoUrl)/"
Say "  Agent folder:  $dir"
Say "  Start agent:   cd ""$dir""; claude      (or codex, or any agent in that folder)"
Say "  Pre-flight:    $(Join-Path $PSScriptRoot 'check.ps1')"
Say "  Between takes: $(Join-Path $PSScriptRoot 'reset.ps1')"
