"""
NOVA Echo Sidecar — Real-time Streaming STT
FastAPI + WebSocket + faster-whisper + Silero VAD
Replaces the batch HTTP server with streaming pipeline.
"""

import os
import sys
import json
import asyncio
import tempfile
import logging
import argparse
from pathlib import Path
from typing import Optional, AsyncGenerator
from contextlib import asynccontextmanager

import numpy as np
try:
    import torch
except ImportError:
    torch = None
    print("WARNING: torch not installed — VAD and GPU disabled, sidecar will run in stub mode")
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
try:
    import uvicorn
except ImportError:
    uvicorn = None

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("echo")

# Global state
MODEL = None
MODEL_NAME = "base"
VAD_MODEL = None
try:
    DEVICE = "cuda" if torch and torch.cuda.is_available() else "cpu"
    COMPUTE_TYPE = "float16" if torch and torch.cuda.is_available() else "int8"
except:
    DEVICE = "cpu"
    COMPUTE_TYPE = "int8"

# Audio constants
SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 100  # 100ms chunks
CHUNK_SIZE = int(SAMPLE_RATE * CHUNK_DURATION_MS / 1000)  # 1600 samples
VAD_THRESHOLD = 0.5
MIN_SPEECH_DURATION_MS = 250
MAX_SILENCE_DURATION_MS = 800

# Active WebSocket connections
active_connections: dict[str, dict] = {}


def load_asr_model(name: str = "base"):
    """Load faster-whisper model."""
    global MODEL, MODEL_NAME
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        logger.error("faster-whisper not installed. Run: pip install faster-whisper")
        return None

    logger.info(f"Loading ASR model: {name} on {DEVICE} ({COMPUTE_TYPE})")
    MODEL = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE)
    MODEL_NAME = name
    logger.info(f"ASR model {name} loaded successfully")
    return MODEL


def load_vad_model():
    """Load Silero VAD model."""
    global VAD_MODEL
    try:
        vad_model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            trust_repo=True
        )
        VAD_MODEL = vad_model
        logger.info("Silero VAD loaded successfully")
        return vad_model, utils
    except Exception as e:
        logger.warning(f"Silero VAD load failed: {e}. VAD disabled.")
        return None, None


def vad_available() -> bool:
    return VAD_MODEL is not None


def resample_audio(audio: np.ndarray, orig_sr: int, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    """Resample audio to target sample rate."""
    if orig_sr == target_sr:
        return audio
    try:
        import torchaudio.transforms as T
        resampler = T.Resample(orig_sr, target_sr)
        return resampler(torch.from_numpy(audio)).numpy()
    except Exception:
        # Fallback: simple linear interpolation
        ratio = target_sr / orig_sr
        new_length = int(len(audio) * ratio)
        return np.interp(np.linspace(0, len(audio), new_length), np.arange(len(audio)), audio).astype(np.float32)


def int16_to_float32(audio: bytes) -> np.ndarray:
    """Convert raw int16 bytes to float32 numpy array normalized to [-1, 1]."""
    arr = np.frombuffer(audio, dtype=np.int16)
    return arr.astype(np.float32) / 32768.0


def float32_to_int16(audio: np.ndarray) -> bytes:
    """Convert float32 numpy array to int16 bytes."""
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767).astype(np.int16).tobytes()


class VADProcessor:
    """Silero VAD wrapper for voice activity detection."""

    def __init__(self, threshold: float = VAD_THRESHOLD):
        self.threshold = threshold
        self.sample_rate = SAMPLE_RATE
        self.window_size = 512  # Silero expects 512 samples at 16kHz

    def is_speech(self, audio_chunk: np.ndarray) -> bool:
        """Check if audio chunk contains speech."""
        if not vad_available():
            return True  # No VAD = assume speech

        try:
            # Ensure correct chunk size
            if len(audio_chunk) != self.window_size:
                # Pad or trim
                if len(audio_chunk) < self.window_size:
                    audio_chunk = np.pad(audio_chunk, (0, self.window_size - len(audio_chunk)))
                else:
                    audio_chunk = audio_chunk[:self.window_size]

            # Convert to tensor
            tensor = torch.from_numpy(audio_chunk).unsqueeze(0)
            with torch.no_grad():
                speech_prob = VAD_MODEL(tensor, self.sample_rate).item()
            return speech_prob >= self.threshold
        except Exception:
            return True  # Fail open


class StreamingTranscriber:
    """Handles streaming transcription with VAD-based segmentation."""

    def __init__(self, language: Optional[str] = None, prompt: str = "", word_timestamps: bool = False):
        self.language = language
        self.prompt = prompt
        self.word_timestamps = word_timestamps
        self.vad = VADProcessor()
        self.buffer = np.array([], dtype=np.float32)
        self.speech_buffer = np.array([], dtype=np.float32)
        self.silence_chunks = 0
        self.speech_chunks = 0
        self.in_speech = False
        self.last_result = ""

    def add_audio(self, audio_chunk: np.ndarray) -> Optional[dict]:
        """Add audio chunk, return transcription if turn complete."""
        if len(audio_chunk) == 0:
            return None

        self.buffer = np.concatenate([self.buffer, audio_chunk])

        # Process in VAD window sizes
        results = []
        while len(self.buffer) >= self.vad.window_size:
            chunk = self.buffer[:self.vad.window_size]
            self.buffer = self.buffer[self.vad.window_size:]

            is_speech = self.vad.is_speech(chunk)

            if is_speech:
                self.silence_chunks = 0
                self.speech_chunks += 1
                self.speech_buffer = np.concatenate([self.speech_buffer, chunk])
                self.in_speech = True
            else:
                if self.in_speech:
                    self.silence_chunks += 1
                    self.speech_buffer = np.concatenate([self.speech_buffer, chunk])

                    # Check for end of speech
                    silence_ms = self.silence_chunks * CHUNK_DURATION_MS
                    speech_ms = len(self.speech_buffer) / SAMPLE_RATE * 1000

                    if silence_ms >= MAX_SILENCE_DURATION_MS and speech_ms >= MIN_SPEECH_DURATION_MS:
                        # Transcribe the speech segment
                        result = self._transcribe_segment(self.speech_buffer)
                        if result:
                            results.append(result)
                        # Reset
                        self.speech_buffer = np.array([], dtype=np.float32)
                        self.speech_chunks = 0
                        self.in_speech = False
                        self.silence_chunks = 0
                # else: ignore leading silence

        return results[-1] if results else None

    def _transcribe_segment(self, audio: np.ndarray) -> Optional[dict]:
        """Transcribe a complete speech segment."""
        if MODEL is None:
            return None

        try:
            segments, info = MODEL.transcribe(
                audio,
                language=self.language,
                initial_prompt=self.prompt if self.prompt else None,
                word_timestamps=self.word_timestamps,
                vad_filter=False,  # We do our own VAD
                condition_on_previous_text=False,
            )

            text = " ".join([seg.text for seg in segments]).strip()
            if not text:
                return None

            result = {
                "text": text,
                "language": info.language,
                "language_probability": info.language_probability,
                "duration_ms": int(len(audio) / SAMPLE_RATE * 1000),
            }

            if self.word_timestamps:
                result["words"] = [
                    {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                    for seg in segments for w in (seg.words or [])
                ]

            return result

        except Exception as e:
            logger.error(f"Transcription error: {e}")
            return None

    def flush(self) -> Optional[dict]:
        """Flush remaining buffered speech."""
        if len(self.speech_buffer) > SAMPLE_RATE * 0.5:  # At least 500ms
            return self._transcribe_segment(self.speech_buffer)
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    global MODEL, VAD_MODEL
    logger.info("Starting NOVA Echo sidecar...")

    # Load models
    load_asr_model(MODEL_NAME)
    load_vad_model()

    yield

    logger.info("Shutting down NOVA Echo sidecar...")
    MODEL = None
    VAD_MODEL = None


app = FastAPI(
    title="NOVA Echo Sidecar",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "vad": vad_available(),
        "active_connections": len(active_connections),
    }


@app.post("/transcribe")
async def transcribe_batch(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    prompt: str = Form(""),
    word_timestamps: bool = Form(False),
):
    """Batch transcription endpoint (backward compatible)."""
    if MODEL is None:
        raise HTTPException(503, "ASR model not loaded")

    # Normalize language: "auto" / "" / "null" means auto-detect (None)
    if language is not None:
        lang = str(language).strip().lower()
        if lang in ("", "auto", "null", "none", "detect"):
            language = None
        elif lang not in ("af","am","ar","as","az","ba","be","bg","bn","bo","br","bs","ca","cs","cy","da","de","el","en","es","et","eu","fa","fi","fo","fr","gl","gu","ha","haw","he","hi","hr","ht","hu","hy","id","is","it","ja","jw","ka","kk","km","kn","ko","la","lb","ln","lo","lt","lv","mg","mi","mk","ml","mn","mr","ms","mt","my","ne","nl","nn","no","oc","pa","pl","ps","pt","ro","ru","sa","sd","si","sk","sl","sn","so","sq","sr","su","sv","sw","ta","te","tg","th","tk","tl","tr","tt","uk","ur","uz","vi","yi","yo","zh","yue"):
            logger.warning(f"Invalid language '{language}' — falling back to auto-detect")
            language = None
        else:
            language = lang

    # Read and convert audio
    audio_bytes = await file.read()
    # Guard against empty upload
    if not audio_bytes or len(audio_bytes) < 100:
        raise HTTPException(400, "Empty audio file received — please speak again")
    audio = None
    audio_load_error = None
    try:
        # Try to decode with torchaudio (handles wav, mp3, webm/opus if ffmpeg/torchcodec available)
        import torchaudio
        import io
        waveform, sr = torchaudio.load(io.BytesIO(audio_bytes))
        audio = waveform.mean(dim=0).numpy()  # Mono
        audio = resample_audio(audio, sr)
    except Exception as e:
        audio_load_error = str(e)[:400]
        # Try ffmpeg subprocess as second fallback (handles webm/opus without torchcodec)
        # ffmpeg is installed via winget (9.0.1) — use it to convert any container to wav/pcm
        try:
            import subprocess
            # quick check if audio looks like a container (not raw PCM)
            header = audio_bytes[:12]
            is_container = header.startswith(b"RIFF") or header.startswith(b"\x1a\x45\xdf\xa3") or header.startswith(b"OggS") or header[:4] == b"\x1a\x45\xdf\xa3" or b"webm" in header.lower() or b"opus" in header.lower() or b"ID3" in header[:3]
            # also try ffmpeg for any non-PCM if torchaudio failed, regardless of header
            if True:
                import os as _os
                ffmpeg_bin = _os.environ.get("FFMPEG_BINARY") or _os.environ.get("FFMPEG_PATH") or "ffmpeg"
                # also try absolute winGet path if ffmpeg not in PATH
                if ffmpeg_bin == "ffmpeg":
                    # probe winGet ffmpeg
                    win_ff = r"C:\Users\dhana\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe"
                    try:
                        if _os.path.exists(win_ff):
                            ffmpeg_bin = win_ff
                    except: pass
                proc = subprocess.run(
                    [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "wav", "-ac", "1", "-ar", str(SAMPLE_RATE), "-acodec", "pcm_s16le", "pipe:1"],
                    input=audio_bytes,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=8,
                )
                if proc.returncode == 0 and proc.stdout and len(proc.stdout) > 44:
                    # parse wav header and extract PCM
                    wav_data = proc.stdout
                    # skip 44-byte wav header, convert remaining to float32
                    pcm_bytes = wav_data[44:]
                    if len(pcm_bytes) >= 2 and len(pcm_bytes) % 2 == 0:
                        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                        audio_load_error = None
                    else:
                        raise Exception(f"ffmpeg output too small: {len(pcm_bytes)}")
                else:
                    raise Exception(f"ffmpeg failed rc={proc.returncode} stderr={proc.stderr[:200].decode(errors='ignore')}")
        except Exception as ffmpeg_e:
            # keep original torchaudio error if ffmpeg also fails, then try PCM fallback
            if audio_load_error is None:
                audio_load_error = str(ffmpeg_e)[:300]
            else:
                audio_load_error = f"{audio_load_error} | ffmpeg:{str(ffmpeg_e)[:200]}"
            # Fallback: assume raw int16 PCM only if data looks like PCM (size %2==0 and not container)
            try:
                header = audio_bytes[:12]
                is_container = header.startswith(b"RIFF") or header.startswith(b"\x1a\x45\xdf\xa3") or header[:3] == b"ID3" or header[:2] == b"\xff\xfb" or b"OggS" in header[:8]
                if is_container:
                    raise Exception("container detected, not raw PCM")
            except Exception:
                pass
            try:
                audio = int16_to_float32(audio_bytes)
            except Exception as e2:
                raise HTTPException(400, f"Audio decode failed: {audio_load_error} / fallback {str(e2)[:120]}")

    if audio is None or len(audio) < SAMPLE_RATE * 0.3:
        # too short (<0.3s) — likely silence or click, return empty gracefully instead of 500
        return JSONResponse({"text": "", "language": language or "en", "language_probability": 0, "duration_ms": int(len(audio or []) / SAMPLE_RATE * 1000) if audio is not None else 0, "model": MODEL_NAME, "note": "audio too short"})

    # Transcribe
    try:
        segments, info = MODEL.transcribe(
            audio,
            language=language,
            initial_prompt=prompt if prompt else None,
            word_timestamps=word_timestamps,
        )
    except ValueError as ve:
        # faster-whisper raises ValueError for invalid language code like "auto"
        if "not a valid language code" in str(ve):
            logger.warning(f"Invalid language {language} caused ValueError, retrying with auto-detect")
            segments, info = MODEL.transcribe(audio, language=None, initial_prompt=prompt if prompt else None, word_timestamps=word_timestamps)
        else:
            raise

    text = " ".join([seg.text for seg in segments]).strip()

    result = {
        "text": text,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration_ms": int(len(audio) / SAMPLE_RATE * 1000),
        "model": MODEL_NAME,
    }

    if word_timestamps:
        result["words"] = [
            {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
            for seg in segments for w in (seg.words or [])
        ]

    return JSONResponse(result)


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    """WebSocket streaming transcription endpoint."""
    await websocket.accept()
    conn_id = id(websocket)
    logger.info(f"WebSocket connected: {conn_id}")

    # Connection state
    state = {
        "transcriber": None,
        "language": None,
        "prompt": "",
        "word_timestamps": False,
        "buffer": bytearray(),
    }
    active_connections[conn_id] = state

    try:
        while True:
            message = await websocket.receive()

            if "bytes" in message:
                # Binary audio chunk
                audio_bytes = message["bytes"]
                state["buffer"].extend(audio_bytes)

                # Initialize transcriber on first audio
                if state["transcriber"] is None:
                    state["transcriber"] = StreamingTranscriber(
                        language=state["language"],
                        prompt=state["prompt"],
                        word_timestamps=state["word_timestamps"],
                    )

                # Process audio (expect raw int16 PCM at 16kHz mono)
                audio_chunk = int16_to_float32(audio_bytes)
                result = state["transcriber"].add_audio(audio_chunk)

                if result:
                    await websocket.send_json({
                        "type": "transcript",
                        "final": True,
                        **result,
                    })

            elif "text" in message:
                # Control message
                try:
                    control = json.loads(message["text"])
                    msg_type = control.get("type")

                    if msg_type == "config":
                        state["language"] = control.get("language")
                        state["prompt"] = control.get("prompt", "")
                        state["word_timestamps"] = control.get("word_timestamps", False)
                        # Recreate transcriber with new config
                        state["transcriber"] = StreamingTranscriber(
                            language=state["language"],
                            prompt=state["prompt"],
                            word_timestamps=state["word_timestamps"],
                        )
                        await websocket.send_json({"type": "config_ack"})

                    elif msg_type == "flush":
                        if state["transcriber"]:
                            result = state["transcriber"].flush()
                            if result:
                                await websocket.send_json({
                                    "type": "transcript",
                                    "final": True,
                                    **result,
                                })
                            # Reset for next utterance
                            state["transcriber"] = StreamingTranscriber(
                                language=state["language"],
                                prompt=state["prompt"],
                                word_timestamps=state["word_timestamps"],
                            )

                    elif msg_type == "ping":
                        await websocket.send_json({"type": "pong"})

                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {conn_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        active_connections.pop(conn_id, None)


@app.websocket("/ws/tts")
async def websocket_tts(websocket: WebSocket):
    """WebSocket streaming TTS endpoint (Piper)."""
    await websocket.accept()
    conn_id = id(websocket)
    logger.info(f"TTS WebSocket connected: {conn_id}")

    try:
        while True:
            message = await websocket.receive_text()
            control = json.loads(message)

            if control.get("type") == "synthesize":
                text = control.get("text", "")
                voice = control.get("voice", "en_US-lessac-medium")
                language = control.get("language", "en")

                if not text:
                    await websocket.send_json({"type": "error", "message": "Empty text"})
                    continue

                # Stream synthesis
                try:
                    from piper import PiperVoice
                    import subprocess

                    # Use Piper CLI for streaming
                    proc = subprocess.Popen(
                        ["piper", "--model", voice, "--output_raw"],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )
                    stdout, _ = proc.communicate(input=text.encode())

                    # Send audio chunks
                    chunk_size = 3200  # 100ms at 16kHz
                    for i in range(0, len(stdout), chunk_size):
                        chunk = stdout[i:i + chunk_size]
                        await websocket.send_bytes(chunk)

                    await websocket.send_json({"type": "done"})

                except Exception as e:
                    await websocket.send_json({"type": "error", "message": str(e)})

    except WebSocketDisconnect:
        logger.info(f"TTS WebSocket disconnected: {conn_id}")
    except Exception as e:
        logger.error(f"TTS WebSocket error: {e}")


def main():
    parser = argparse.ArgumentParser(description="NOVA Echo Sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default=os.environ.get("ECHO_MODEL", "base"),
                        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"])
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()

    global MODEL_NAME
    MODEL_NAME = args.model

    logger.info(f"Starting NOVA Echo on {args.host}:{args.port} with model {MODEL_NAME}")

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        workers=args.workers,
        log_level="info",
    )


if __name__ == "__main__":
    main()