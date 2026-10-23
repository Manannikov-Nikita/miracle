@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0local.ps1" stop %*
if errorlevel 1 (
  echo.
  echo Command failed. Read the message above.
  pause
  exit /b 1
)
