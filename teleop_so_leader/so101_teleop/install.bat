@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.12+ from https://www.python.org/downloads/
  echo During setup, check "Add python.exe to PATH".
  exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
if errorlevel 1 (
  echo This kit needs Python 3.12 or newer.
  python --version
  exit /b 1
)

if not exist ".venv" (
  echo Creating .venv ...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo.
echo Setup finished. Next: keep this window or run:
echo   .venv\Scripts\activate
echo Then follow SETUP.md starting at "Find USB ports".
endlocal
