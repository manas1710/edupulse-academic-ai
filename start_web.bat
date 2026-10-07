@echo off
cd /d "%~dp0"
echo Starting EduPulse Academic AI Web Server...
.\venv\Scripts\python.exe app.py
pause
