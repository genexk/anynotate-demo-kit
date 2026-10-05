<#
.SYNOPSIS
  Pre-flight before a demo or a recording. Changes nothing.
.DESCRIPTION
  Exits 1 when a required check fails; warnings do not fail.
#>
param([string]$Path)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$dir = if ($Path) { $Path } else { Get-DefaultDemoDir }
$script:failed = $false
function Ok([string]$m) { Say "  ok    $m" }
function Bad([string]$m) { Say "  FAIL  $m"; $script:failed = $true }
function Meh([string]$m) { Say "  warn  $m" }

Say 'Anynotate demo pre-flight'

if (Test-Command 'git') { Ok 'git' } else { Bad 'git is not installed' }

if (Test-Command 'bun') { Ok 'bun (live reload)' }
elseif ((Test-Command 'python3') -or (Test-Command 'python')) { Meh 'bun not found; python serves the page without live reload' }
else { Bad 'neither bun nor python is installed' }

if (Test-Command 'anynotate') {
  & anynotate doctor *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'anynotate doctor' } else { Bad 'anynotate doctor reports a problem (run it to see which)' }
} else {
  Bad 'anynotate is not on PATH'
}

if (Test-DemoClone $dir) {
  Ok "demo clone at $dir"
  if (Invoke-Git -C $dir status --porcelain) { Meh 'demo files have changes; run reset.ps1 for a clean start' }
  else { Ok 'demo files are untouched' }
} else {
  Bad "no demo clone at $dir (run setup.ps1)"
}

if (Test-ServerUp) {
  $body = (Invoke-WebRequest -Uri "$($script:DemoUrl)/" -UseBasicParsing -TimeoutSec 2).Content
  if ("$body" -match 'Tomato soup') { Ok "page served at $($script:DemoUrl)/" }
  else { Bad "$($script:DemoUrl)/ answers but is not the demo page" }
} else {
  Bad "nothing is serving $($script:DemoUrl)/ (run setup.ps1)"
}

$pending = @(Get-DemoBundles).Count
if ($pending -eq 0) { Ok 'no old demo notes in the inbox' }
else { Meh "$pending old demo bundle(s) in the inbox; reset.ps1 removes them" }

$agents = @('claude', 'codex', 'herdr') | Where-Object { Test-Command $_ }
if (@($agents).Count -gt 0) { Ok "agents found: $($agents -join ' ')" }
else { Meh 'no claude, codex or herdr on PATH; use the Inbox with any other agent' }

Say ''
Say 'Also check by hand: Chrome window 1280x800, bookmarks bar hidden, zoom 100%, no unsent notes in the dock.'

if ($script:failed) {
  Say 'Some required checks failed.'
  exit 1
}
Say 'Ready to record.'
