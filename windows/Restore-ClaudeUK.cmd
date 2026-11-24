@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restore-ClaudeUKShortcut.ps1"
if errorlevel 1 (
  echo.
  echo Failed to restore the original Start Menu shortcut.
  pause
)
