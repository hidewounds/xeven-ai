"use strict";

const express = require("express");
const { authenticateIntegration, requireScope } = require("../../auth/integration");
const { transcribeParams, stubTranscribe } = require("../../core/echo/transcribe");
const { normalizeLanguage } = require("../../core/echo/languages");
const env = require("../../env");

const router = express.Router();
router.use(authenticateIntegration);

// POST /api/v1/echo/transcribe
// Body: { language?, model?, audioBase64?, mimeType?, durationMs?, customerId?, conversationId? }
// or multipart (handled as raw fallback). Stub path persists a transcript row and returns status.
router.post("/transcribe", requireScope("echo:transcribe"), express.json({ limit: "10mb" }), async (req, res, next) => {
    try {
        const body = req.body || {};
        const bizCfg = (() => { try { return require("../../core/config/service").getConfig(req.xeven.businessId); } catch { return {}; } })();
        const prompt = String(body.prompt || bizCfg.echo?.initialPrompt || "").slice(0, 600);
        const params = transcribeParams({ language: body.language, model: body.model, prompt, wordTimestamps: body.wordTimestamps === true || bizCfg.echo?.wordTimestamps === true });
        const customerId = String(body.customerId || body.customer_id || "anonymous").slice(0, 80);
        const conversationId = body.conversationId ? String(body.conversationId).slice(0, 100) : null;

        // Parity: local sidecar vs Vercel OpenAI — same UX, different backend
        const bizSidecar = (() => { try { return require("../../core/config/service").getConfig(req.xeven.businessId).echo?.sidecarUrl; } catch { return ""; } })();
        const sidecarUrl = (bizSidecar || env.echoSidecarUrl || "").trim();
        const hasAudio = body.audioBase64 && typeof body.audioBase64 === "string" && body.audioBase64.length > 20;

        if (hasAudio) {
            // 1. try sidecar if configured and available (local)
            if (sidecarUrl) {
                try {
                    const buf = Buffer.from(body.audioBase64, "base64");
                    if (buf.length < 100) throw new Error("audio too small");
                    const { callSidecar } = require("../../core/echo/transcribe");
                    const result = await callSidecar({
                        sidecarUrl,
                        audioBuffer: buf,
                        filename: `audio.${(body.mimeType || "webm").split("/")[1] || "webm"}`,
                        params,
                    });
                    if (result && result.text && result.text.trim()) {
                        const db = require("../../db").get();
                        const crypto = require("../../lib/crypto");
                        const id = `ect_${crypto.randomHex(10)}`;
                        db().prepare("INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                            .run(id, req.xeven.businessId, customerId, conversationId, result.language || params.language || "", result.text || "", body.durationMs || 0, Date.now(), params.prompt || "", JSON.stringify(result.segments?.flatMap((s) => s.words || []) || []), params.model || "turbo");
                        return res.json({ transcriptId: id, text: result.text, language: result.language || params.language, segments: result.segments || [], wordTimestamps: params.wordTimestamps, sidecar: true, via: "sidecar" });
                    }
                } catch (e) {
                    req.log && req.log.warn && req.log.warn("echo sidecar failed, trying Whisper", { error: e.message });
                }
            }
            // 2. OpenAI Whisper fallback — primary for Vercel (no sidecar), same quality as local
            const hasValidKey = (() => {
                const k = (env.ai.openaiApiKey || "").trim();
                return k.startsWith("sk-") && k.length > 20 && !k.includes("...") && !k.includes("placeholder");
            })();
            if (hasValidKey) {
                try {
                    const buf = Buffer.from(body.audioBase64, "base64");
                    if (buf.length < 100) throw new Error("audio too small");
                    const { callOpenAIWhisper } = require("../../core/echo/transcribe");
                    const whisper = await callOpenAIWhisper({
                        audioBuffer: buf,
                        filename: `audio.${(body.mimeType || "webm").split("/")[1] || "webm"}`,
                        language: params.language,
                        prompt: params.prompt,
                        apiKey: env.ai.openaiApiKey || process.env.OPENAI_API_KEY,
                        baseUrl: env.ai.openaiBaseUrl || process.env.OPENAI_BASE_URL,
                    });
                    if (whisper && whisper.text && whisper.text.trim()) {
                        const db = require("../../db").get();
                        const crypto = require("../../lib/crypto");
                        const id = `ect_${crypto.randomHex(10)}`;
                        db().prepare("INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                            .run(id, req.xeven.businessId, customerId, conversationId, whisper.language || params.language || "", whisper.text || "", body.durationMs || 0, Date.now(), params.prompt || "", JSON.stringify([]), "whisper-1");
                        return res.json({ transcriptId: id, text: whisper.text, language: whisper.language || params.language, sidecar: false, provider: "openai_whisper", via: "openai" });
                    }
                } catch (e) {
                    req.log && req.log.warn && req.log.warn("whisper fallback failed", { error: e.message });
                }
            } else if (env.isProduction) {
                req.log && req.log.warn && req.log.warn("echo: OPENAI_API_KEY not set on Vercel — trying HF");
            }
            // 2b. HuggingFace Whisper fallback — works with HF_TOKEN (free, no OpenAI needed)
            const hasHfKey = !!((env.hfToken || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || "").trim());
            if (hasHfKey) {
                try {
                    const buf = Buffer.from(body.audioBase64, "base64");
                    if (buf.length < 100) throw new Error("audio too small");
                    const ext = (body.mimeType || "webm").split(";")[0].split("/")[1] || "webm";
                    const { callHuggingFaceWhisper } = require("../../core/echo/transcribe");
                    const hfRes = await callHuggingFaceWhisper({ audioBuffer: buf, filename: `audio.${ext}`, language: params.language, hfToken: env.hfToken || process.env.HF_TOKEN });
                    if (hfRes && hfRes.text && hfRes.text.trim()) {
                        const db = require("../../db").get();
                        const crypto = require("../../lib/crypto");
                        const id = `ect_${crypto.randomHex(10)}`;
                        db().prepare("INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                            .run(id, req.xeven.businessId, customerId, conversationId, hfRes.language || params.language || "", hfRes.text || "", body.durationMs || 0, Date.now(), params.prompt || "", JSON.stringify([]), env.hfWhisperModel || "openai/whisper-large-v3");
                        return res.json({ transcriptId: id, text: hfRes.text, language: hfRes.language || params.language, sidecar: false, provider: "hf_whisper", via: "huggingface" });
                    }
                } catch (e) {
                    req.log && req.log.warn && req.log.warn("hf whisper failed", { error: e.message });
                }
            }
        }

        const audioMeta = { format: body.mimeType || "webm", bytes: hasAudio ? Buffer.from(body.audioBase64, "base64").length : 0, durationMs: body.durationMs || 0 };
        const stub = stubTranscribe({ businessId: req.xeven.businessId, customerId, conversationId, language: params.language, audioMeta, prompt: params.prompt, wordTimestamps: params.wordTimestamps, model: params.model });
        // Parity hint: tell client whether server STT is expected (openai/hf) or must use browser — Option 3
        const hasValidKeyEcho = (() => { const k = (env.ai.openaiApiKey || "").trim(); return k.startsWith("sk-") && k.length > 20 && !k.includes("..."); })();
        const hasHfKeyEcho = !!((env.hfToken || process.env.HF_TOKEN || "").trim());
        if (!sidecarUrl && (hasValidKeyEcho || hasHfKeyEcho)) stub.via = hasValidKeyEcho ? "openai" : "huggingface";
        else if (!sidecarUrl) { stub.clientFallback = "browser_stt"; stub.via = "client"; }
        res.json(stub);
    } catch (e) { next(e); }
});

// GET /api/v1/echo/languages
router.get("/languages", requireScope("echo:read"), (req, res, next) => {
    try {
        const { ECHO_LANGUAGES, LANGUAGE_NAMES } = require("../../core/echo/languages");
        res.json({ languages: ECHO_LANGUAGES, names: LANGUAGE_NAMES });
    } catch (e) { next(e); }
});

module.exports = router;
