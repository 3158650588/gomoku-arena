@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the local game server.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\play-local.mjs" %*
if errorlevel 1 pause
