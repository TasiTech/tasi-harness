$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $scriptDir 'tasi.ps1') @args
exit $LASTEXITCODE
