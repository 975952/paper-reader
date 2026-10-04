@echo off
chcp 65001 >nul
title 论文阅读器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没有找到 Node.js
  echo       请先装一个： https://nodejs.org  （装 LTS 版，一路下一步即可）
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动论文阅读器…
node server.js

echo.
echo   服务已停止。
pause
