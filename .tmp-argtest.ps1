param()
Write-Host "args=$($args -join ',')"
& powershell -NoProfile -Command "Write-Output ARGS: `$args" @args
