@echo off
rem Double-click this to use the tool: it builds what has changed, starts the
rem local server, and opens the app in this machine's browser. Using it does not
rem begin with remembering a command (ADR 0002).
rem
rem Closing this window stops the server, and with it the Projects the tool
rem started for itself.

setlocal
cd /d "%~dp0"

call pnpm build
if errorlevel 1 goto broken

call pnpm record serve --open
if errorlevel 1 goto broken

endlocal
exit /b 0

:broken
echo.
echo record could not start. What went wrong is above.
pause
exit /b 1
