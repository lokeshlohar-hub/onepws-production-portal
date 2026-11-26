@echo off
rem Give the PostgreSQL "postgres" user a new password (when nobody remembers the old one). No data is changed.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Reset-Postgres-Password.ps1" 
echo.
pause
