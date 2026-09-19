#!/bin/bash
# XEVEN Echo Sidecar Startup Script
# Usage: ./echo/start.sh [model] [port]

set -e

MODEL=${1:-base}
PORT=${2:-8765}
HOST=${3:-127.0.0.1}

echo "Starting XEVEN Echo sidecar..."
echo "Model: $MODEL"
echo "Port: $PORT"
echo "Host: $HOST"

# Check if faster-whisper is installed
python -c "import faster_whisper" 2>/dev/null || {
    echo "Installing faster-whisper..."
    pip install faster-whisper
}

# Check if Silero VAD is available
python -c "import torch; torch.hub.load('snakers4/silero-vad', 'silero_vad', force_reload=False)" 2>/dev/null || {
    echo "Silero VAD will be downloaded on first run"
}

# Start the sidecar
cd "$(dirname "$0")"
exec python server.py --model "$MODEL" --port "$PORT" --host "$HOST"