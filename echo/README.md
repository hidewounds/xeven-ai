# XEVEN Echo — sidecar (adapted from xeven-echo / openai-whisper)

This directory is the **copied + adapted** speech substrate for XEVEN.
Original: `openai/whisper` (MIT) — now stored as `xeven-echo` reference at `D:\xeven-references\xeven-echo`.
License retained at `LICENSE.echo`.

## What's in here
- `audio.py`, `transcribe.py`, `model.py`, `tokenizer.py`, `decoding.py` — core whisper modules as vendored reference (not edited)
- `server.py` — tiny HTTP wrapper XEVEN Node calls: `POST /transcribe` (multipart `file`) → `{text, language}`

## Run
```
pip install -U openai-whisper
pip install torch --index-url https://download.pytorch.org/whl/cpu  # or CUDA build
python echo/server.py --model turbo --port 8765
```
Set `ECHO_SIDECAR_URL=http://127.0.0.1:8765` in XEVEN's `.env` (optional — XEVEN degrades gracefully without it).

## Where it's used
- `server/src/core/echo/transcribe.js` — Node wrapper (stub + sidecar call)
- `server/src/routes/v1/widget.js` & `server/src/routes/portal` — upload → transcript → `runChat()`
- Voice role `voice_receptionist` consumes transcripts as normal chat turns.

## MeloTTS sidecar (multilingual speech)

`melo-server.py` — local multilingual TTS over HTTP, engine
[myshell-ai/MeloTTS](https://github.com/myshell-ai/MeloTTS) (MIT).
CPU real-time; languages EN, ES, FR, ZH, JP, KR.

```
pip install -r echo/requirements-melo.txt   # downloads models on first run
python echo/melo-server.py --port 8766
```

Set `XEVEN_MELO_SIDECAR_URL=http://127.0.0.1:8766` (or per-business
`meloSidecarUrl`). Select per call with `model: "melo"` (`ttsParams`,
`speak()`, `POST /api/v1/tts/synthesize`). Voices via
`listVoices("melo", lang)`, EN fallback for uncovered languages.
Unreachable sidecar falls through to the standard TTS chain —
a missing sidecar never breaks speech.
