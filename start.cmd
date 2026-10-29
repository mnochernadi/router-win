@echo off
rem Start the router-win dashboard and open it.
rem
rem   start.cmd                  start here; runs default to the router's scratch dir
rem   start.cmd C:\my\project    start with that project as the default working directory
rem
rem Uses node directly: npm.ps1 is blocked under the default ExecutionPolicy.
setlocal
set "PROJ=%~1"
if not exist "%~dp0bin\xray.exe" (
  echo first run: setting up
  node "%~dp0lib\setup.js" || goto :fail
)
if defined PROJ (
  if not exist "%PROJ%" ( echo no such directory: %PROJ% & goto :fail )
  cd /d "%PROJ%"
) else (
  cd /d "%~dp0"
)
start "" http://127.0.0.1:8790
node "%~dp0server.js"
goto :eof
:fail
pause
