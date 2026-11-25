@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-ClaudeUK.ps1"
if errorlevel 1 (
  echo.
  echo ClaudeSpoof launch failed. The process was closed; read the error above.
  pause
)
