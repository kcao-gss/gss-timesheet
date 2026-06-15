@echo off
rem Launch the GSS Timesheet desktop app (Electron).
rem For a no-console, double-click .exe build instead, run:  npm run dist
cd /d "%~dp0"
".\node_modules\.bin\electron.cmd" "%~dp0"
