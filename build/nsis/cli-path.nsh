!macro customInstall
  DetailPrint "Adding Tasi Harness CLI to the user PATH"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$installDir = '$INSTDIR'; $current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $current) { $current = '' }; $parts = $current -split ';' | Where-Object { $_ -and $_.Trim() }; $exists = $false; foreach ($part in $parts) { if ($part.TrimEnd('\') -ieq $installDir.TrimEnd('\')) { $exists = $true } }; if (-not $exists) { $next = (@($parts) + $installDir) -join ';'; [Environment]::SetEnvironmentVariable('Path', $next, 'User') }"`
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  DetailPrint "Removing Tasi Harness CLI from the user PATH"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$installDir = '$INSTDIR'; $current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($null -eq $current) { exit 0 }; $parts = $current -split ';' | Where-Object { $_ -and $_.Trim() -and ($_.TrimEnd('\') -ine $installDir.TrimEnd('\')) }; [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')"`
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
