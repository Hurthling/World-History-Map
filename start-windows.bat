@echo off
chcp 65001 >nul
rem Starts a local web server and opens the map in the browser.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000"
  node tools\serve.mjs
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000"
  python -m http.server 8000
  goto :eof
)
echo Node.js or Python is needed to run the map locally.
echo Install Node.js from https://nodejs.org and run this file again.
pause
