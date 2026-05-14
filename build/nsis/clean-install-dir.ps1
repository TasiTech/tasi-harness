param(
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  exit 0
}

function Normalize-InstallPath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }

  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

$resolved = Normalize-InstallPath $InstallDir
$userHome = Normalize-InstallPath ([Environment]::GetFolderPath('UserProfile'))
$localAppData = Normalize-InstallPath ([Environment]::GetFolderPath('LocalApplicationData'))
$appData = Normalize-InstallPath ([Environment]::GetFolderPath('ApplicationData'))
$programFiles = Normalize-InstallPath ([Environment]::GetFolderPath('ProgramFiles'))
$programFilesX86 = Normalize-InstallPath ([Environment]::GetFolderPath('ProgramFilesX86'))
$programData = Normalize-InstallPath ([Environment]::GetFolderPath('CommonApplicationData'))
$harnessHome = Normalize-InstallPath (Join-Path $userHome '.tasi-harness')

$blockedExactPaths = @(
  $userHome,
  $localAppData,
  $appData,
  $programFiles,
  $programFilesX86,
  $programData,
  $harnessHome
) | Where-Object { $_ }

foreach ($path in $blockedExactPaths) {
  if ([string]::Equals($resolved, $path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean protected path: $resolved"
  }
}

$harnessPrefix = $harnessHome + [System.IO.Path]::DirectorySeparatorChar
if ($harnessHome -and $resolved.StartsWith($harnessPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean user data path: $resolved"
}

if ($resolved -match '^[A-Za-z]:$' -or $resolved.Length -lt 8) {
  throw "Refusing to clean unsafe install path: $resolved"
}

if (Test-Path -LiteralPath $resolved) {
  Get-ChildItem -LiteralPath $resolved -Force | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Force -Path $resolved | Out-Null
}
