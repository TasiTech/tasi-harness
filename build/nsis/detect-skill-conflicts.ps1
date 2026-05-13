param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [Parameter(Mandatory = $true)]
  [string]$OutPath,

  [string]$LocalRoot = (Join-Path $env:USERPROFILE '.tasi-harness\skills'),

  [int]$Limit = 18
)

$local = @{}

if (Test-Path -LiteralPath $LocalRoot) {
  Get-ChildItem -LiteralPath $LocalRoot -Filter SKILL.md -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $raw = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
    $folder = Split-Path -Leaf (Split-Path -Parent $_.FullName)
    $name = ''

    if ($raw -match '(?s)^---\s*(.*?)\s*---') {
      foreach ($line in $Matches[1] -split "`r?`n") {
        if ($line -match '^\s*name\s*:\s*(.+?)\s*$') {
          $name = $Matches[1].Trim().Trim('"').Trim("'")
          break
        }
      }
    }

    if (-not $name) { $name = $folder }

    if ($name) { $local[$name.ToLowerInvariant()] = $true }
    if ($folder) { $local[$folder.ToLowerInvariant()] = $true }
  }
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$names = @()

foreach ($skill in $manifest.skills) {
  $name = [string]$skill.name
  $folder = [string]$skill.folder
  if (-not $folder) { $folder = $name }
  $nameKey = if ($name) { $name.ToLowerInvariant() } else { '' }
  $folderKey = if ($folder) { $folder.ToLowerInvariant() } else { '' }
  if (($nameKey -and $local.ContainsKey($nameKey)) -or ($folderKey -and $local.ContainsKey($folderKey))) {
    $names += $folder
  }
}

$names = $names | Select-Object -First $Limit
Set-Content -LiteralPath $OutPath -Encoding ASCII -Value $names
