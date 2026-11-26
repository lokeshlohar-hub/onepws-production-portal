@echo off
rem FINAL SYNC right before the switch-over: replace the office copy with a fresh copy from Supabase.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Portal-Database.ps1" -Refresh
echo.
pause
