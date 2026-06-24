@echo off
cd /d "%~dp0"
echo Starting Niagara Connector...
echo.
echo A setup page will open in your browser.
echo If Node.js is missing, please install Node.js first.
echo.
npm run connector:start
pause
