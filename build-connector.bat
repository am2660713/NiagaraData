@echo off
cd /d "%~dp0"
echo Building Niagara Connector EXE...
echo.
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
echo.
call npm run connector:build
if errorlevel 1 (
  echo Connector build failed.
  pause
  exit /b 1
)
echo.
echo Connector EXE is ready in the dist folder.
pause
