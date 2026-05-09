@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tasi.ps1" %*
exit /b %ERRORLEVEL%
