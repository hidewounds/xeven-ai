@echo off
REM XEVEN Echo Sidecar Startup Script (Windows)
REM Usage: echo\start.bat [model] [port]

set MODEL=%1
set PORT=%2
set HOST=%3

if "%MODEL%"=="" set MODEL=base
if "%PORT%"=="" set PORT=8765
if "%HOST%"=="" set HOST=127.0.0.1

echo Starting XEVEN Echo sidecar...
echo Model: %MODEL%
echo Port: %PORT%
echo Host: %HOST%

REM Check if faster-whisper is installed
python -c "import faster_whisper" 2>nul || (
    echo Installing faster-whisper...
    pip install faster-whisper
)

REM Start the sidecar
cd /d "%~dp0"
python server.py --model %MODEL% --port %PORT% --host %HOST%