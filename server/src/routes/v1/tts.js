"use strict";

/**
 * TTS (Text-to-Speech) endpoints.
 * POST /api/v1/tts/synthesize - synthesize text to speech
 * GET  /api/v1/tts/voices - list available voices
 */

const express = require("express");
const { authenticateIntegration, requireScope } = require("../../auth/integration");
const { synthesize, listVoices, ttsParams } = require("../../core/echo/tts");
const configService = require("../../core/config/service");
const env = require("../../env");

const router = express.Router();
router.use(authenticateIntegration);

/**
 * POST /api/v1/tts/synthesize
 * Body: { text, voice?, model?, language?, speed?, stability?, similarityBoost?, style? }
 * Returns: { synthId, audioBase64, format, durationMs, text, status }
 */
router.post("/synthesize", requireScope("tts:synthesize"), express.json({ limit: "1mb" }), async (req, res, next) => {
    try {
        authenticateIntegration(req, res, () => {});
        if (req.nova?.businessId === undefined) return;

        const body = req.body || {};
        const text = String(body.text || "").trim();
        if (!text) return res.status(400).json({ error: { code: "invalid_params", message: "Text is required" } });

        const params = ttsParams({
            voice: body.voice,
            model: body.model,
            language: body.language,
            speed: body.speed,
            stability: body.stability,
            similarityBoost: body.similarityBoost,
            style: body.style,
        });

        const config = configService.getConfig(req.nova.businessId);
        const result = await require("../../core/echo/tts").synthesize({
            businessId: req.nova.businessId,
            text: body.text,
            params,
            config: {
                ttsSidecarUrl: config.echo?.ttsSidecarUrl || env.NOVA_TTS_SIDECAR_URL || env.echoSidecarUrl,
            },
        });
        // For rewired Echo: if server TTS returns no audio (no sidecar/key on Vercel), tell client to use browser TTS
        if(!result.audioBase64 && result.status === "pending_provider"){
            result.clientFallback = "browser_tts";
            result.message = result.message || "Server TTS not available — browser will speak";
        }
        res.json(result);
    } catch (e) {
        next(e);
    }
});

/**
 * GET /api/v1/tts/voices
 * Query: model?, language?
 * Returns available voices for a model/language combination.
 */
router.get("/voices", requireScope("tts:read"), (req, res, next) => {
    try {
        authenticateIntegration(req, res, () => {});
        if (req.nova?.businessId === undefined) return;

        const { listVoices, normalizeLanguage } = require("../../core/echo/tts");
        const model = String(req.query.model || "piper").toLowerCase();
        const language = normalizeLanguage(req.query.language) || "en";
        const voices = listVoices(req.query.model, req.query.language);
        res.json({ model: req.query.model || "piper", language, voices });
    } catch (e) { next(e); }
});

module.exports = router;