@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-ClaudeUK.ps1"
if errorlevel 1 (
  echo.
  echo Claude UK launch failed. The test process was closed; read the error above.
  pause
)
