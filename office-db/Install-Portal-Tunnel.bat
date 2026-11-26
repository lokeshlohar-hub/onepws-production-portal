@echo off
rem Install the Cloudflare tunnel service (outbound only) for the Production Portal database.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Portal-Tunnel.ps1" 
echo.
pause
