@echo off
rem Start the router-win dashboard and open it.
rem Uses node directly: npm.ps1 is blocked under the default ExecutionPolicy.
setlocal
cd /d "%~dp0"
if not exist "bin\xray.exe" (
  echo first run: setting up
  node lib\setup.js || goto :fail
)
start "" http://127.0.0.1:8790
node server.js
goto :eof
:fail
pause
