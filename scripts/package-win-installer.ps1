param(
  [switch]$SkipBuild,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Show-Usage {
  @'
Usage:
  powershell -ExecutionPolicy Bypass -File scripts/package-win-installer.ps1
  powershell -ExecutionPolicy Bypass -File scripts/package-win-installer.ps1 -SkipBuild

Options:
  -SkipBuild   Skip `npm run build` before packaging.
  -Help        Show this help message.
'@ | Write-Host
}

if ($Help) {
  Show-Usage
  exit 0
}

if ($env:OS -ne 'Windows_NT') {
  throw 'The Windows installer script must be run on Windows.'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $RepoRoot 'release'

Push-Location $RepoRoot
try {
  $Args = @('scripts/package-installers.mjs', '--win')
  if ($SkipBuild) {
    $Args += '--skip-build'
  }

  & node @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed (exit code $LASTEXITCODE)"
  }
}
finally {
  Pop-Location
}
