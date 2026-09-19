"""
XEVEN MeloTTS sidecar — local multilingual TTS over HTTP.
MeloTTS engine: myshell-ai/MeloTTS (MIT). CPU real-time capable.

Contract (mirrors the echo sidecar conventions):
  POST /synthesize  {text, language, speaker_id, speed}
    -> {audioBase64, format: "wav", durationMs, sampleRate, language, speaker_id}
  GET /health -> {ok, engine: "melotts", languages: [...]}

Run:
  pip install -r echo/requirements-melo.txt
  python echo/melo-server.py --port 8766
Wire: XEVEN_MELO_SIDECAR_URL=http://127.0.0.1:8766 (or per-business
meloSidecarUrl). The Node side falls through to the standard TTS chain
when the sidecar is unreachable — a missing sidecar never breaks speech.
"""

import argparse
import base64
import io
import logging
import wave

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("melo")

try:
    from melo.api import TTS as MeloTTS
except ImportError:  # pragma: no cover - missing optional dep
    MeloTTS = None

app = FastAPI(title="XEVEN MeloTTS sidecar")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

_MODELS = {}


class SynthRequest(BaseModel):
    text: str = ""
    language: str = "EN"
    speaker_id: str = ""
    speed: float = 1.0


def _default_speaker(language):
    table = {
        "EN": "EN-US",
        "ES": "ES",
        "FR": "FR",
        "ZH": "ZH",
        "JP": "JP",
        "KR": "KR",
    }
    return table.get(str(language or "EN").upper(), "EN-US")


def _get_model(language):
    if MeloTTS is None:
        raise RuntimeError("melotts package not installed (pip install -r echo/requirements-melo.txt)")
    lang = str(language or "EN").upper()
    if lang not in _MODELS:
        logger.info("loading MeloTTS language %s", lang)
        _MODELS[lang] = MeloTTS(language=lang, device="cpu")
    return _MODELS[lang]


@app.get("/health")
def health():
    return {"ok": True, "engine": "melotts", "languages": ["EN", "ES", "FR", "ZH", "JP", "KR"]}


@app.post("/synthesize")
def synthesize(req: SynthRequest):
    text = (req.text or "").strip()[:5000]
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    language = (req.language or "EN").upper()
    speaker = req.speaker_id or _default_speaker(language)
    speed = min(2.0, max(0.5, float(req.speed or 1.0)))
    try:
        model = _get_model(language)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    buf = io.BytesIO()
    try:
        model.tts_to_file(text, speaker, buf, speed=speed, quiet=True)
    except TypeError:
        # older melotts signature without quiet flag
        buf = io.BytesIO()
        model.tts_to_file(text, speaker, buf, speed=speed)
    raw = buf.getvalue()
    # melo writes wav bytes; sniff duration from the header when possible
    duration_ms = 0
    try:
        with wave.open(io.BytesIO(raw), "rb") as w:
            duration_ms = int(w.getnframes() / float(w.getframerate()) * 1000)
    except Exception:
        duration_ms = max(500, len(text) * 70)
    return JSONResponse(
        {
            "audioBase64": base64.b64encode(raw).decode("ascii"),
            "format": "wav",
            "durationMs": duration_ms,
            "sampleRate": 44100,
            "language": language,
            "speaker_id": speaker,
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
