$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tasiExe = Join-Path $scriptDir 'Tasi Harness.exe'
$tasiCli = ''
$unpackedCli = Join-Path $scriptDir 'resources\app\dist\main\cli.js'
$asarPath = Join-Path $scriptDir 'resources\app.asar'

if (Test-Path -LiteralPath $unpackedCli) {
  $tasiCli = $unpackedCli
} elseif (Test-Path -LiteralPath $asarPath) {
  $tasiCli = Join-Path $scriptDir 'resources\app.asar\dist\main\cli.js'
}

if (-not (Test-Path -LiteralPath $tasiExe)) {
  Write-Error 'Tasi Harness executable was not found next to this command.'
  exit 1
}

if (-not $tasiCli) {
  Write-Error 'Tasi Harness CLI script was not found in the installed app resources.'
  exit 1
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8

$env:ELECTRON_RUN_AS_NODE = '1'
$env:TASI_CLI_FORCE_MAIN = '1'
$env:NODE_NO_WARNINGS = '1'

function ConvertTo-WindowsCommandLineArgument {
  param([string]$Value)

  if ($null -eq $Value -or $Value.Length -eq 0) {
    return '""'
  }

  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $result = '"'
  $backslashes = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq '\') {
      $backslashes += 1
    } elseif ($char -eq '"') {
      $result += ('\' * (($backslashes * 2) + 1))
      $result += '"'
      $backslashes = 0
    } else {
      if ($backslashes -gt 0) {
        $result += ('\' * $backslashes)
        $backslashes = 0
      }
      $result += $char
    }
  }

  if ($backslashes -gt 0) {
    $result += ('\' * ($backslashes * 2))
  }

  $result += '"'
  return $result
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $tasiExe
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $false
$processArgs = @($tasiCli) + @($args | ForEach-Object { [string]$_ })
$startInfo.Arguments = ($processArgs | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' '

$process = [System.Diagnostics.Process]::Start($startInfo)
$process.WaitForExit()
exit $process.ExitCode
