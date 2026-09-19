# Xeven AI — free mode ($0 operation)

Everything below runs without spending anything: local models, bundled
fallbacks, and the mock provider. Any path that needs money is listed
under "On hold" with its exact unblock condition.

## Zero-cost stack

| Need | Free path | How |
|---|---|---|
| Chat LLM | Mock provider (dev/tests) or any OpenAI-compatible endpoint | `AI_PROVIDER=mock`, or point `OPENAI_BASE_URL` at local Ollama (`http://127.0.0.1:11434/v1`) — `baseUrl` flows from model config, no code change |
| Speech-to-text | Whisper sidecar, local | `pip install -r echo/requirements.txt`, `python echo/server.py --port 8765`, `ECHO_SIDECAR_URL=http://127.0.0.1:8765` (CPU `tiny`/`base` models) |
| Speech output | Piper sidecar (local) or MeloTTS sidecar (local) | `XEVEN_TTS_SIDECAR_URL` for Piper; `XEVEN_MELO_SIDECAR_URL=http://127.0.0.1:8766` + `pip install -r echo/requirements-melo.txt` for EN/ES/FR/ZH/JP/KR voices |
| Meeting notes | Built-in heuristic | `core/echo/notes.js` resolves without any provider (`source: "heuristic"`) |
| Database, mail catch | SQLite (WAL) + logs | default; SMTP only sends if configured |
| Tests | Mock provider + temp DBs | `npm test` (no keys, no network) |

## Graceful degradation (no keys configured)

- Transcribe: sidecar → OpenAI → HuggingFace → stub (`pending_sidecar`, "please type").
- Synthesize: sidecar → OpenAI → MeloTTS-selected sidecar → stub (`audioBase64: null`).
- Notes: model → heuristic. Never throws, never invents beyond the transcript.
- Check liveness without spending: `GET /api/health`, `GET /api/health/echo`.

## On hold — needs money or hardware (not started, no dead code)

| Item | Needs | Unblocks when |
|---|---|---|
| Telephony bridge (Jambonz) | SIP trunk + number + Linux host | trunk credentials + VPS; then new `voice-bridge/` WS app over existing transcribe→chat→synthesize |
| D-ID talking avatar | D-ID account + credits | `data-client-key` + `data-agent-id`; website demo section first |
| OpenVoice cloning (myshell-ai, MIT) | GPU box + GB model downloads | GPU host; then 3rd echo sidecar + `tts.js` provider entry (MeloTTS pattern) |
| ElevenLabs voices | API key | `ELEVENLABS_API_KEY`; plumbing already in `tts.js` |
| strix pentest in CI | LLM key + staging target | `npx skills add usestrix/strix`, nightly workflow vs staging API |
| Prompt-asset pipeline (zsky) | Max-tier API key | only for marketing art; nothing product-side needs it |

## Removed as unrequired

- `backup/`, `backup-20260907-0258/` — stale full-tree copies (mirrored to local Temp before removal; live secrets also lived in `backup/.env`, now gone from the tree).
- Root `log.txt` — runtime-generated, regenerates.
- Kept deliberately: `training/` (RL research, unreferenced by runtime, tiny — owner's call).
