@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js LTS를 먼저 설치하세요: https://nodejs.org/
  pause
  exit /b 1
)
node scripts\setup.mjs
if errorlevel 1 (
  echo 설치하지 못했습니다. 위 오류를 확인하세요.
  pause
  exit /b 1
)
pause
