@echo off
chcp 65001 >nul
title Paper Reader
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] Node.js not found. Install it first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting paper reader...
node server.js

echo.
echo   Server stopped.
pause
