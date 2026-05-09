@echo off
setlocal
set "TASI_EXE=%~dp0Tasi Harness.exe"
set "TASI_CLI="
if exist "%~dp0resources\app\dist\main\cli.js" set "TASI_CLI=%~dp0resources\app\dist\main\cli.js"
if not defined TASI_CLI if exist "%~dp0resources\app.asar" set "TASI_CLI=%~dp0resources\app.asar\dist\main\cli.js"
if not exist "%TASI_EXE%" (
  echo Tasi Harness executable was not found next to this command. 1>&2
  exit /b 1
)
if not defined TASI_CLI (
  echo Tasi Harness CLI script was not found in the installed app resources. 1>&2
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
set "TASI_CLI_FORCE_MAIN=1"
"%TASI_EXE%" "%TASI_CLI%" %*
