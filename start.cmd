@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js LTS가 필요합니다: https://nodejs.org/
  pause
  exit /b 1
)
node scripts\start.mjs
if errorlevel 1 pause
