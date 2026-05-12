!macro customInit
  DetailPrint "Preparing clean Tasi Harness installation directory"
  InitPluginsDir
  File /oname=$PLUGINSDIR\clean-install-dir.ps1 "${BUILD_RESOURCES_DIR}\nsis\clean-install-dir.ps1"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\clean-install-dir.ps1" -InstallDir "$INSTDIR"`
  Pop $0
  StrCmp $0 "0" clean_install_done
  MessageBox MB_ICONSTOP "Tasi Harness could not clean the existing installation directory. Close any running Tasi Harness windows and try the installer again."
  Abort
clean_install_done:
!macroend

!macro customInstall
  DetailPrint "Adding Tasi Harness CLI to the user PATH"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$installDir = '$INSTDIR'; $$aliasDir = Join-Path $$env:LOCALAPPDATA 'Microsoft\WindowsApps'; New-Item -ItemType Directory -Force -Path $$aliasDir | Out-Null; $$current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$null -eq $$current) { $$current = '' }; $$parts = $$current -split ';' | Where-Object { $$_ -and $$_.Trim() }; foreach ($$desired in @($$installDir)) { $$exists = $$false; foreach ($$part in $$parts) { if ($$part.TrimEnd('\') -ieq $$desired.TrimEnd('\')) { $$exists = $$true } }; if (-not $$exists) { $$parts = @($$parts) + $$desired } }; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User'); $$nl = [Environment]::NewLine; $$dq = [char]34; $$sq = [char]39; foreach ($$base in @('tasi', 'tasi-harness')) { $$cmdTarget = Join-Path $$installDir ($$base + '.cmd'); if (Test-Path -LiteralPath $$cmdTarget) { $$cmdShim = '@echo off' + $$nl + $$dq + $$cmdTarget + $$dq + ' %*' + $$nl; Set-Content -LiteralPath (Join-Path $$aliasDir ($$base + '.cmd')) -Value $$cmdShim -Encoding ASCII }; $$psTarget = Join-Path $$installDir ($$base + '.ps1'); if (Test-Path -LiteralPath $$psTarget) { $$psShim = '& ' + $$sq + $$psTarget + $$sq + ' @args' + $$nl + 'exit $$LASTEXITCODE' + $$nl; Set-Content -LiteralPath (Join-Path $$aliasDir ($$base + '.ps1')) -Value $$psShim -Encoding UTF8 } }"`
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  DetailPrint "Removing Tasi Harness CLI from the user PATH"
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$installDir = '$INSTDIR'; $$aliasDir = Join-Path $$env:LOCALAPPDATA 'Microsoft\WindowsApps'; $$current = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$null -ne $$current) { $$parts = $$current -split ';' | Where-Object { $$_ -and $$_.Trim() -and ($$_.TrimEnd('\') -ine $$installDir.TrimEnd('\')) }; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User') }; foreach ($$name in @('tasi.cmd', 'tasi-harness.cmd', 'tasi.ps1', 'tasi-harness.ps1')) { $$shimPath = Join-Path $$aliasDir $$name; if (Test-Path -LiteralPath $$shimPath) { $$content = Get-Content -LiteralPath $$shimPath -Raw -ErrorAction SilentlyContinue; if ($$content -like ('*' + $$installDir + '*')) { Remove-Item -LiteralPath $$shimPath -Force -ErrorAction SilentlyContinue } } }"`
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
