@echo off
cd /d "%~dp0"
call venv\Scripts\activate.bat
echo ==================================================
echo   Starting FacultyApp in Auto-Reload Mode...
echo   (The app will restart automatically when files change)
echo ==================================================
watchmedo auto-restart --directory=.\ --pattern="*.py;*.html;*.js;*.css" --recursive -- .\venv\Scripts\python.exe main.py
pause
