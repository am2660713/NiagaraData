@echo off
cd /d "%~dp0"
if exist "dist\NiagaraConnector.exe" (
  echo Starting packaged Niagara Connector...
  echo.
  start "" "dist\NiagaraConnector.exe"
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:3031"
  exit /b 0
)

echo Starting Niagara Connector in developer mode...
echo.
echo A setup page will open in your browser.
echo If Node.js is missing, please install Node.js first.
echo.
npm run connector:start
pause
