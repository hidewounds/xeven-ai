"use strict";

/**
 * ECHO — Speech-to-text.
 * NOVA-side abstraction over the whisper (nova-echo) sidecar.
 * Supports both batch HTTP and WebSocket streaming.
 */

const crypto = require("../../lib/crypto");
const db = require("../../db").get;
const { normalizeLanguage } = require("./languages");

const ECHO_MODELS = ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3", "turbo"];

function transcribeParams({ language, model, prompt, wordTimestamps } = {}) {
    const lang = normalizeLanguage(language);
    const m = typeof model === "string" && ECHO_MODELS.includes(model.trim().toLowerCase()) ? model.trim().toLowerCase() : "base";
    return {
        language: lang,
        model: m,
        prompt: typeof prompt === "string" ? prompt.slice(0, 600) : "",
        wordTimestamps: wordTimestamps === true,
    };
}

async function callOpenAIWhisper({ audioBuffer, filename, language, prompt, apiKey, baseUrl }) {
    const key = (apiKey || process.env.OPENAI_API_KEY || require("../../env").ai.openaiApiKey || "").trim();
    const url = (baseUrl || process.env.OPENAI_BASE_URL || require("../../env").ai.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "") + "/audio/transcriptions";
    if (!key || key.includes("...") || key.length < 20) throw new Error("OPENAI_API_KEY missing or invalid for Whisper");
    const form = new FormData();
    form.append("file", new Blob([audioBuffer]), filename || "audio.webm");
    form.append("model", "whisper-1");
    if (language && language !== "auto") form.append("language", language);
    if (prompt) form.append("prompt", String(prompt).slice(0, 200));
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
        res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: controller.signal });
    } finally { clearTimeout(t); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Whisper error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return { text: data.text || "", language: data.language || language || "" };
}

async function callHuggingFaceWhisper({ audioBuffer, filename, language, hfToken }) {
    const key = (hfToken || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HF_API_TOKEN || require("../../env").hfToken || "").trim();
    if (!key || key.length < 10) throw new Error("HF_TOKEN missing for Whisper");
    // HF inference: openai/whisper-large-v3 is most accurate, also tiny for speed
    const model = "openai/whisper-large-v3";
    const url = `https://api-inference.huggingface.co/models/${model}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
        // HF expects raw bytes, not multipart — send as binary with audio/* content-type
        const ext = (filename || "audio.wav").split(".").pop().toLowerCase();
        const ctype = ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : ext === "webm" ? "audio/webm" : "audio/wav";
        res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": ctype,
            },
            body: audioBuffer,
            signal: controller.signal,
        });
    } finally { clearTimeout(t); }
    const data = await res.json().catch(async () => ({ text: await res.text().catch(() => "") }));
    if (!res.ok) {
        const msg = data.error || data.warning || JSON.stringify(data).slice(0, 400);
        throw new Error(`HF Whisper error ${res.status}: ${msg}`);
    }
    // HF returns {text: "..."} or [{generated_text: "..."}] depending on model
    const text = data.text || data.generated_text || (Array.isArray(data) && data[0]?.generated_text) || (Array.isArray(data) && data[0]?.text) || "";
    if (!text && data.error) throw new Error(data.error);
    return { text: String(text).trim(), language: language || "" };
}

/**
 * Stub transcription (sidecar not available). Persists audio metadata as an
 * echo transcript so the conversation still flows. Now tries OpenAI Whisper before stub.
 */
function stubTranscribe({ businessId, customerId, conversationId, language, audioMeta, prompt, wordTimestamps, model }) {
    const transcriptId = `ect_${crypto.randomHex(10)}`;
    const now = Date.now();
    const lang = normalizeLanguage(language) || "";
    try {
        db().prepare(
            "INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        ).run(
            transcriptId,
            businessId,
            customerId,
            conversationId || null,
            lang,
            `[audio received: ${audioMeta?.format || "webm"} ${audioMeta?.bytes || 0} bytes — echo sidecar not available, Whisper fallback attempted]`,
            audioMeta?.durationMs || 0,
            now,
            String(prompt || "").slice(0, 600),
            JSON.stringify(wordTimestamps ? [] : []),
            String(model || "base").slice(0, 20)
        );
    } catch {}
    return {
        transcriptId,
        text: "",
        language: lang,
        status: "pending_sidecar",
        message: "Voice received — echo sidecar not running. For now please type your message.",
    };
}

/**
 * Batch HTTP call to sidecar (backward compatible).
 */
async function callSidecar({ sidecarUrl, audioBuffer, filename, params }) {
    if (!sidecarUrl || !audioBuffer) throw new Error("sidecarUrl and audioBuffer required");
    // Skip sidecar on Vercel when URL is empty or localhost (no sidecar in serverless)
    if (!sidecarUrl.trim() || (/127\.0\.0\.1|localhost/.test(sidecarUrl) && process.env.VERCEL)) {
        throw new Error("Sidecar not available in serverless");
    }
    // Fix filename from mimeType like "audio/webm;codecs=opus" → "audio.webm" not "audio.webm;codecs=opus"
    let safeFilename = filename || "audio.webm";
    if (safeFilename.includes(";")) safeFilename = safeFilename.split(";")[0];
    if (!safeFilename.includes(".")) safeFilename += ".webm";
    // Ensure proper extension from mime if needed
    const form = new FormData();
    form.append("file", new Blob([audioBuffer]), safeFilename);
    // params.language is already normalized (null = auto). Never send "auto" string to sidecar.
    if (params.language && params.language !== "auto") form.append("language", params.language);
    if (params.model) form.append("model", params.model);
    if (params.prompt) form.append("prompt", params.prompt);
    if (params.wordTimestamps) form.append("word_timestamps", "1");
    const url = `${sidecarUrl.replace(/\/$/, "")}/transcribe`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
        res = await fetch(url, { method: "POST", body: form, signal: controller.signal });
    } finally { clearTimeout(t); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.detail || `Echo sidecar error ${res.status}: ${JSON.stringify(data).slice(0,300)}`);
    return data;
}

/**
 * WebSocket streaming transcription session.
 * Returns a controller with sendAudio(), sendConfig(), flush(), close().
 */
function createStreamingSession({ sidecarUrl, businessId, customerId, conversationId, params = {} }) {
    let ws = null;
    let connected = false;
    let transcriptId = null;
    let transcriptBuffer = "";
    let onTranscriptCallback = null;
    let onErrorCallback = null;

    const wsUrl = sidecarUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/transcribe";

    function connect() {
        return new Promise((resolve, reject) => {
            try {
                const WebSocket = require("ws");
                ws = new WebSocket(wsUrl);

                ws.on("open", () => {
                    connected = true;
                    // Send initial config
                    ws.send(JSON.stringify({
                        type: "config",
                        language: params.language,
                        prompt: params.prompt,
                        word_timestamps: params.wordTimestamps,
                    }));
                    resolve();
                });

                ws.on("message", (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        handleMessage(msg);
                    } catch (e) {
                        // Ignore parse errors
                    }
                });

                ws.on("error", (err) => {
                    connected = false;
                    if (onErrorCallback) onErrorCallback(err);
                    reject(err);
                });

                ws.on("close", () => {
                    connected = false;
                });

                // Timeout
                setTimeout(() => {
                    if (!connected) {
                        ws.terminate();
                        reject(new Error("WebSocket connection timeout"));
                    }
                }, 10000);
            } catch (e) {
                reject(e);
            }
        });
    }

    function handleMessage(msg) {
        if (msg.type === "transcript") {
            transcriptBuffer = msg.text;
            if (onTranscriptCallback) {
                onTranscriptCallback({
                    text: msg.text,
                    language: msg.language,
                    final: msg.final,
                    words: msg.words,
                });
            }
            if (msg.final) {
                persistTranscript(msg);
            }
        } else if (msg.type === "error") {
            if (onErrorCallback) onErrorCallback(new Error(msg.message));
        }
    }

    function persistTranscript(msg) {
        if (!transcriptId) {
            transcriptId = `ect_${crypto.randomHex(10)}`;
        }
        const now = Date.now();
        try {
            db().prepare(
                "INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
            ).run(
                transcriptId,
                businessId,
                customerId,
                conversationId || null,
                msg.language || params.language || "",
                msg.text,
                msg.duration_ms || 0,
                now,
                params.prompt || "",
                JSON.stringify(msg.words || []),
                params.model || "base"
            );
        } catch {}
    }

    async function sendAudio(audioBuffer) {
        if (!connected || !ws || ws.readyState !== 1) {
            throw new Error("WebSocket not connected");
        }
        // Expect raw int16 PCM at 16kHz mono
        ws.send(audioBuffer);
    }

    function sendConfig(config) {
        if (!connected || !ws) return;
        ws.send(JSON.stringify({ type: "config", ...config }));
    }

    function flush() {
        if (!connected || !ws) return;
        ws.send(JSON.stringify({ type: "flush" }));
    }

    function close() {
        if (ws) {
            ws.close();
            ws = null;
        }
        connected = false;
    }

    function onTranscript(cb) {
        onTranscriptCallback = cb;
    }

    function onError(cb) {
        onErrorCallback = cb;
    }

    return {
        connect,
        sendAudio,
        sendConfig,
        flush,
        close,
        onTranscript,
        onError,
        isConnected: () => connected,
        getTranscriptId: () => transcriptId,
    };
}

/**
 * Check if sidecar is available (HTTP health check).
 * On Vercel serverless, localhost sidecar never exists — return false immediately without fetch.
 */
async function checkSidecarHealth(sidecarUrl) {
    if (!sidecarUrl || !String(sidecarUrl).trim()) return { available: false, reason: "no_url" };
    if (/127\.0\.0\.1|localhost/.test(String(sidecarUrl)) && process.env.VERCEL) {
        return { available: false, reason: "serverless_no_localhost" };
    }
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${String(sidecarUrl).replace(/\/$/, "")}/health`, { method: "GET", signal: controller.signal });
        clearTimeout(t);
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            return { available: true, ...data };
        }
        return { available: false, status: res.status };
    } catch (e) {
        return { available: false, error: e.message };
    }
}

module.exports = {
    ECHO_MODELS,
    transcribeParams,
    stubTranscribe,
    callSidecar,
    callOpenAIWhisper,
    callHuggingFaceWhisper,
    createStreamingSession,
    checkSidecarHealth,
};