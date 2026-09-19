"use strict";

/**
 * ECHO — Text-to-speech.
 * XEVEN-side abstraction over the TTS sidecar (or local fallback).
 * Supports multiple providers: Piper (local), ElevenLabs, OpenAI, etc.
 */

const crypto = require("../../lib/crypto");
const db = require("../../db").get;
const { normalizeLanguage } = require("./languages");

const TTS_MODELS = {
    piper: { name: "piper", provider: "piper", multilingual: true, streaming: true },
    elevenlabs: { name: "elevenlabs", provider: "elevenlabs", multilingual: true, streaming: true },
    openai: { name: "tts-1", provider: "openai-compatible", multilingual: true, streaming: true },
    openai_hd: { name: "tts-1-hd", provider: "openai-compatible", multilingual: true, streaming: true },
    // MeloTTS (myshell-ai/MeloTTS, MIT) — local multilingual file synthesis.
    // CPU real-time, one model per language; not a streaming engine.
    melo: { name: "melo", provider: "melo", multilingual: true, streaming: false },
};

const TTS_VOICES = {
    // Piper voices (sample)
    piper: {
        en_US: ["amy", "ryan", "kathleen", "emma"],
        en_GB: ["alan", "libby"],
        de_DE: ["thorsten", "eva"],
        fr_FR: ["gilles", "siwis"],
        es_ES: ["carlfm", "davefx"],
        fr_CA: ["gabrielle"],
    },
    // MeloTTS speakers (upstream myshell-ai/MeloTTS language set).
    // Extend per upstream docs; unknown languages fall back to EN-US.
    melo: {
        EN: ["EN-US", "EN-BR", "EN_INDIA", "EN-AU"],
        ES: ["ES"],
        FR: ["FR"],
        ZH: ["ZH"],
        JP: ["JP"],
        KR: ["KR"],
    },
    // ElevenLabs voices (subset)
    elevenlabs: {
        rachel: { name: "Rachel", category: "female", language: "en" },
        domi: { name: "Domi", category: "female", language: "en" },
        bella: { name: "Bella", category: "female", language: "en" },
        antoni: { name: "Antoni", category: "male", language: "en" },
        elli: { name: "Elli", category: "female", language: "en" },
        josh: { name: "Josh", category: "male", language: "en" },
        arnold: { name: "Arnold", category: "male", language: "en" },
        adam: { name: "Adam", category: "male", language: "en" },
        sam: { name: "Sam", category: "male", language: "en" },
    },
};

function ttsParams({ voice, model, language, speed, stability, similarityBoost, style } = {}) {
    const lang = normalizeLanguage(language) || "en";
    const m = typeof model === "string" ? model.trim().toLowerCase() : "piper";
    const v = typeof voice === "string" ? voice : null;
    return {
        language: lang,
        model: m,
        voice: v,
        speed: typeof speed === "number" ? Math.max(0.5, Math.min(2, speed)) : 1.0,
        stability: typeof stability === "number" ? Math.max(0, Math.min(1, stability)) : 0.5,
        similarityBoost: typeof similarityBoost === "number" ? Math.max(0, Math.min(1, similarityBoost)) : 0.75,
        style: typeof style === "number" ? Math.max(0, Math.min(1, style)) : 0,
    };
}

/**
 * Stub TTS (no sidecar/provider configured). Returns a placeholder so the
 * conversation can continue gracefully while TTS is being set up.
 */
function stubSynthesize({ businessId, text, params }) {
    const synthId = `tts_${require("../../lib/crypto").randomHex(10)}`;
    const textPreview = String(text || "").slice(0, 100);
    return {
        synthId,
        text: textPreview,
        audioUrl: null,
        audioBase64: null,
        durationMs: 0,
        format: "mp3",
        status: "pending_provider",
        message: `TTS not configured — ${textPreview.length > 50 ? textPreview.slice(0, 47) + "..." : textPreview}`,
        params,
    };
}

async function callOpenAITTS({ text, voice, model, apiKey, baseUrl }) {
    const key = (apiKey || process.env.OPENAI_API_KEY || require("../../env").ai.openaiApiKey || "").trim();
    const url = (baseUrl || process.env.OPENAI_BASE_URL || require("../../env").ai.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "") + "/audio/speech";
    if (!key || key.includes("...") || key.length < 20 || key.includes("placeholder")) throw new Error("OPENAI_API_KEY missing or invalid for TTS");
    const mdl = (model && model.includes("hd")) ? "tts-1-hd" : "tts-1";
    const v = voice && ["alloy","echo","fable","onyx","xeven","shimmer"].includes(voice) ? voice : "alloy";
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: mdl, input: String(text).slice(0, 4000), voice: v, response_format: "mp3" }),
            signal: controller.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`OpenAI TTS error ${res.status}: ${err.slice(0,300)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("OpenAI TTS returned empty audio");
    return { audioBase64: buf.toString("base64"), format: "mp3", durationMs: Math.round((text.length / 15) * 1000) };
}

/**
 * Real sidecar/provider call (when TTS sidecar is running).
 * POSTs text to the TTS sidecar HTTP. Caller is server/src/routes/tts.
 */
async function callSidecar({ sidecarUrl, text, params }) {
    if (!sidecarUrl || !text) throw new Error("sidecarUrl and text required");
    if (!String(sidecarUrl).trim() || (/127\.0\.0\.1|localhost/.test(String(sidecarUrl)) && process.env.VERCEL)) {
        throw new Error("TTS sidecar not available in serverless");
    }
    const form = new FormData();
    form.append("text", text);
    if (params.voice) form.append("voice", params.voice);
    if (params.model) form.append("model", params.model);
    if (params.language) form.append("language", params.language);
    if (params.speed !== undefined) form.append("speed", String(params.speed));
    if (params.stability !== undefined) form.append("stability", String(params.stability));
    if (params.similarityBoost !== undefined) form.append("similarity_boost", String(params.similarityBoost));
    if (params.style !== undefined) form.append("style", String(params.style));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${String(sidecarUrl).replace(/\/$/, "")}/synthesize`, {
            method: "POST",
            body: form,
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `TTS sidecar error ${res.status}`);
        return data; // { audioBase64, format, durationMs, sampleRate }
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * MeloTTS sidecar call (myshell-ai/MeloTTS via echo/melo-server.py).
 * POSTs JSON, expects { audioBase64, format, durationMs, sampleRate }.
 * Throws on any failure so the orchestrator falls through to the next
 * provider — a missing sidecar must never break synthesis.
 */
async function callMeloSidecar({ sidecarUrl, text, language, speaker, speed }) {
    if (!sidecarUrl || !String(sidecarUrl).trim() || !text || !String(text).trim()) throw new Error("sidecarUrl and text required");
    if (/127\.0\.0\.1|localhost/.test(String(sidecarUrl)) && process.env.VERCEL) {
        throw new Error("MeloTTS sidecar not available in serverless");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(`${String(sidecarUrl).replace(/\/$/, "")}/synthesize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: String(text).slice(0, 5000),
                language: language || "EN",
                speaker_id: speaker || "",
                speed: typeof speed === "number" ? speed : 1.0,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `MeloTTS sidecar error ${res.status}`);
        if (!data.audioBase64) throw new Error("MeloTTS sidecar returned no audio");
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Synthesize text to speech with automatic fallback.
 */
async function synthesize({ businessId, text, params: inputParams, config }) {
    const textStr = String(text || "").slice(0, 5000);
    if (!textStr.trim()) throw new Error("Text is required for synthesis");

    const params = ttsParams(inputParams);
    const lang = params.language || "en";
    const model = params.model || "piper";

    const env = require("../../env");

    // MeloTTS first when selected: local multilingual file synthesis.
    // Any failure falls through to the standard chain below.
    if (model === "melo") {
        const meloUrl = (config?.meloSidecarUrl || process.env.XEVEN_MELO_SIDECAR_URL || env.meloSidecarUrl || "").trim();
        if (meloUrl) {
            try {
                const upper = String(lang).toUpperCase();
                const known = (TTS_VOICES.melo[upper] || TTS_VOICES.melo.EN).includes(params.voice || "")
                    ? params.voice
                    : (TTS_VOICES.melo[upper] || TTS_VOICES.melo.EN)[0];
                const result = await callMeloSidecar({
                    sidecarUrl: meloUrl,
                    text: textStr,
                    language: upper,
                    speaker: known,
                    speed: params.speed,
                });
                const crypto = require("../../lib/crypto");
                const db = require("../../db").get();
                try {
                    db().prepare(
                        "INSERT INTO tts_syntheses (synth_id, business_id, text, language, voice, model, audio_base64, format, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
                    ).run(crypto.randomId("tts"), businessId, textStr.slice(0, 100), lang, known || "", "melo", result.audioBase64 || "", result.format || "wav", result.durationMs || 0, Date.now());
                } catch {}
                return { ...result, synthId: `tts_${crypto.randomHex(10)}`, provider: "melo" };
            } catch {
                // fall through to the standard chain
            }
        }
    }

    // Try sidecar first if configured and not on Vercel serverless
    const rawSidecar = (config?.ttsSidecarUrl || process.env.XEVEN_TTS_SIDECAR_URL || env.echoSidecarUrl || "").trim();
    const sidecarUrl = rawSidecar; // empty on Vercel means no sidecar
    if (sidecarUrl) {
        try {
            const result = await callSidecar({ sidecarUrl, text: textStr, params });
            const crypto = require("../../lib/crypto");
            const db = require("../../db").get();
            db().prepare(
                "INSERT INTO tts_syntheses (synth_id, business_id, text, language, voice, model, audio_base64, format, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
            ).run(crypto.randomId("tts"), businessId, textStr.slice(0, 100), lang, params.voice || "", model, result.audioBase64 || "", result.format || "mp3", result.durationMs || 0, Date.now());
            return { ...result, synthId: `tts_${crypto.randomHex(10)}` };
        } catch (e) {
            // fall through to OpenAI
        }
    }
    // OpenAI TTS fallback — works on Vercel with OPENAI_API_KEY (no sidecar needed) — parity with local sidecar
    const hasValidKey = (() => {
        const k = (env.ai.openaiApiKey || "").trim();
        return k.startsWith("sk-") && k.length > 20 && !k.includes("...") && !k.includes("placeholder");
    })();
    if (hasValidKey) {
        try {
            const openaiResult = await callOpenAITTS({
                text: textStr,
                voice: params.voice,
                model: params.model,
                apiKey: env.ai.openaiApiKey || process.env.OPENAI_API_KEY,
                baseUrl: env.ai.openaiBaseUrl || process.env.OPENAI_BASE_URL,
            });
            const crypto = require("../../lib/crypto");
            const db = require("../../db").get();
            try {
                db().prepare(
                    "INSERT INTO tts_syntheses (synth_id, business_id, text, language, voice, model, audio_base64, format, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
                ).run(crypto.randomId("tts"), businessId, textStr.slice(0, 100), lang, params.voice || "alloy", openaiResult.format === "mp3" ? "tts-1" : params.model || "openai", openaiResult.audioBase64 || "", openaiResult.format || "mp3", openaiResult.durationMs || 0, Date.now());
            } catch {}
            return { ...openaiResult, synthId: `tts_${crypto.randomHex(10)}`, provider: "openai_tts" };
        } catch (e) {
            // fall through to stub, but log for debugging
            if (env.isProduction) console.warn("openai tts failed, falling back to browser", e.message);
        }
    } else if (env.isProduction) {
        console.warn("TTS: OPENAI_API_KEY not set on Vercel — using browser TTS fallback");
    }

    // Fallback to stub
    return stubSynthesize({ businessId: "unknown", text: textStr, params });
}

/** List available voices for a model/language. */
function listVoices(model, language) {
    const lang = normalizeLanguage(language) || "en";
    if (model === "piper") {
        const voices = TTS_VOICES.piper[`${language}_${language.toUpperCase()}`] || TTS_VOICES.piper[language] || [];
        return voices.map(v => ({ id: v, name: v, language: language }));
    }
    if (model === "elevenlabs") {
        return Object.entries(TTS_VOICES.elevenlabs).map(([id, v]) => ({ id, ...v }));
    }
    if (model === "openai" || model === "openai-compatible") {
        return ["alloy", "echo", "fable", "onyx", "xeven", "shimmer"].map(v => ({ id: v, name: v, language: "en" }));
    }
    if (model === "melo") {
        const upper = String(lang).toUpperCase();
        const ids = TTS_VOICES.melo[upper] || TTS_VOICES.melo.EN;
        return ids.map(v => ({ id: v, name: v, language: upper }));
    }
    return [];
}

/**
 * High-level speak function for voice chat integration.
 * Returns base64 audio for direct playback.
 */
async function speak({ businessId, text, language, voice }) {
    const configService = require("../config/service");
    const config = configService.getConfig(businessId);
    const params = ttsParams({ voice, model: config.echo?.model || "piper", language });
    const result = await synthesize({ businessId, text, params, config });
    return result;
}

module.exports = {
    TTS_MODELS,
    TTS_VOICES,
    ttsParams,
    stubSynthesize,
    callSidecar,
    callMeloSidecar,
    synthesize,
    speak,
    listVoices,
    normalizeLanguage,
};