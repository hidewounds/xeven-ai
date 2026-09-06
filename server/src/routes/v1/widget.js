"use strict";

const express = require("express");
const configService = require("../../core/config/service");
// Unified brain — no roles, one brain with 6 learned patterns
const { runChat } = require("../../core/chat/service");
const customers = require("../../core/customers/store");
const { extractKey } = require("../../auth/integration");
const audit = require("../../core/audit/store");
const { badRequest, unauthorized } = require("../../lib/errors");
let chronoSlots = null; let echoTranscribe = null; let addonsStore = null;
try { chronoSlots = require("../../core/chrono/slots"); } catch {}
try { echoTranscribe = require("../../core/echo/transcribe"); } catch {}
try { addonsStore = require("../../core/addons/store"); } catch {}

/**
 * Browser-widget endpoints. Authenticated with the business integration key
 * (the same "public key" embedded in the site snippet). Only a sanitized
 * subset of configuration is exposed.
 */

const router = express.Router();

function authenticateWidget(req) {
    const key = extractKey(req);
    if (!key) throw unauthorized("NOVA key is required.", "key_required");

    const business = configService.getBusinessByKey(key);
    if (!business || !business.active) throw unauthorized("Invalid or inactive NOVA key.", "key_invalid");

    const config = configService.getConfig(business.business_id);
    if (config.security.widgetEnabled === false) {
        throw unauthorized("The NOVA widget is disabled for this business.", "widget_disabled");
    }

    req.nova = { principalType: "widget", businessId: business.business_id, businessName: business.business_name };
}

router.get("/config", (req, res, next) => {
    try {
        authenticateWidget(req);
        const fullConfig = configService.getConfig(req.nova.businessId);
        const addons = addonsStore ? addonsStore.listAddons(req.nova.businessId) : [];
        const voiceEnabled = addons.find((a) => a.key === "voice_channel")?.enabled || false;
        const multiEnabled = addons.find((a) => a.key === "multilanguage")?.enabled || false;
        const chrono = (() => { try { return require("../../core/chrono/schedule").getSchedule(req.nova.businessId); } catch { return null; } })();
        const guide = (() => { try { return require("../../core/guide/store").getGuide(req.nova.businessId); } catch { return null; } })();
        const theme = (() => {
            try {
                const t = require("../../core/theme/store").getTheme(req.nova.businessId);
                if (t && t.theme) return t.theme;
                if (fullConfig.site?.theme) return fullConfig.site.theme;
                if (guide && guide.theme) return guide.theme;
            } catch {}
            return null;
        })();
        const customerBase = (() => {
            try {
                const t = require("../../core/theme/store").getTheme(req.nova.businessId);
                if (t && t.customerBase) return t.customerBase;
                if (fullConfig.site?.customerBase) return fullConfig.site.customerBase;
                if (guide && guide.customerBase) return guide.customerBase;
            } catch {}
            return null;
        })();

        res.json({
            config: {
                assistantName: fullConfig.assistant.name,
                role: "unified",
                roleLabel: "Unified Brain",
                brain: "unified",
                patterns: ["customer_support","sales","shopping_assistant","product_advisor","lead_qualification","general_assistant"],
                welcomeMessage:
                    fullConfig.assistant.welcomeMessage ||
                    `Hi! I'm ${fullConfig.assistant.name}. How can I help you today?`,
                addons: { voice_channel: voiceEnabled, multilanguage: multiEnabled },
                chronoEnabled: true,
                voiceEnabled,
                multilanguageEnabled: multiEnabled,
                slotDuration: chrono?.slotDuration || 30,
                greetingTemplate: fullConfig.call?.greetingTemplate || "",
                guideAvailable: Boolean(guide && guide.steps && guide.steps.length),
                siteUrl: fullConfig.site?.url || guide?.siteUrl || "",
                theme: theme || null,
                customerBase: customerBase || null,
            },
        });
    } catch (error) {
        next(error);
    }
});
// GET /api/v1/widget/guide — fetch guide steps for overlay (pointing)
router.get("/guide", (req, res, next) => {
    try {
        authenticateWidget(req);
        const guide = require("../../core/guide/store").getGuide(req.nova.businessId);
        if (!guide) return res.json({ guide: null, message: "No guide. Business owner: run site analyze in Portal." });
        res.json({ guide });
    } catch (error) { next(error); }
});

// GET /api/v1/widget/theme — theme-aware widget, learns design & customer base except restricted
router.get("/theme", (req, res, next) => {
    try {
        authenticateWidget(req);
        const themeData = (() => {
            try { return require("../../core/theme/store").getTheme(req.nova.businessId); } catch { return null; }
        })();
        const cfg = (() => { try { return require("../../core/config/service").getConfig(req.nova.businessId); } catch { return null; } })();
        const theme = themeData?.theme || cfg?.site?.theme || null;
        const customerBase = themeData?.customerBase || cfg?.site?.customerBase || null;
        res.json({ theme, customerBase, updatedAt: themeData?.updatedAt || cfg?.site?.lastAnalyzedAt || null });
    } catch (error) { next(error); }
});

// GET /api/v1/widget/availability — public customer-facing plan (ranked, no rush)
router.get("/availability", (req, res, next) => {
    try {
        authenticateWidget(req);
        const startDate = String(req.query.startDate || req.query.date || "").trim() || undefined;
        const days = Math.min(90, Math.max(1, Number(req.query.days || 14) || 14));
        if (!chronoSlots) throw badRequest("Chrono not available yet.", "not_available");
        const avail = chronoSlots.generateAvailability(req.nova.businessId, { startDate, days, rank: true });
        // trim to customer-friendly shape
        res.json({ availability: avail });
    } catch (error) { next(error); }
});

// POST /api/v1/widget/transcribe — voice note in widget (echo STT)
// Body: { audioBase64, mimeType?, language?, customerId? }
router.post("/transcribe", express.json({ limit: "12mb" }), async (req, res, next) => {
    try {
        authenticateWidget(req);
        const fullConfig = configService.getConfig(req.nova.businessId);
        const addons = addonsStore ? addonsStore.listAddons(req.nova.businessId) : [];
        const voiceOn = addons.find((a) => a.key === "voice_channel")?.enabled || false;
        const multiOn = addons.find((a) => a.key === "multilanguage")?.enabled || false;
        // allow transcribe if either voice or multilanguage enabled; otherwise polite refusal
        if (!voiceOn && !multiOn) {
            return res.status(403).json({ error: { code: "addon_required", message: "Voice/multilanguage add-on not enabled for this business. Enable it in portal → Add-ons." }, requestId: req.requestId });
        }
        const body = req.body || {};
        const customerId = customers.validateCustomerId(body.customerId || body.customer_id) || "anonymous";
        const prompt = String(body.prompt || fullConfig.echo?.initialPrompt || "").slice(0, 600);
        const params = echoTranscribe ? echoTranscribe.transcribeParams({ language: body.language, model: fullConfig.echo?.model, prompt, wordTimestamps: body.wordTimestamps === true || fullConfig.echo?.wordTimestamps === true }) : { language: body.language || null };
        const audioMeta = { format: body.mimeType || "webm", bytes: body.audioBase64 ? Buffer.from(String(body.audioBase64).slice(0, 20000000), "base64").length : 0, durationMs: body.durationMs || 0 };
        // For rewired Echo: sidecar is optional (local) — prod Vercel uses browser STT, so return client_fallback immediately when sidecar not available
        const rawSidecar = fullConfig.echo?.sidecarUrl || require("../../env").echoSidecarUrl || "http://127.0.0.1:8765";
        const sidecarUrl = String(rawSidecar).trim() || "http://127.0.0.1:8765";
        const isProd = require("../../env").isProduction;
        let sidecarAvailable = false;
        try{
            const health = await echoTranscribe.checkSidecarHealth(sidecarUrl);
            sidecarAvailable = !!(health && health.available);
        }catch(e){ sidecarAvailable = false; }
        // If no audio, return stub (for health check)
        if (!body.audioBase64) {
            const stub = echoTranscribe ? echoTranscribe.stubTranscribe({ businessId: req.nova.businessId, customerId, conversationId: body.conversationId || null, language: params.language, audioMeta, prompt: params.prompt, wordTimestamps: params.wordTimestamps, model: params.model }) : { status: "not_available" };
            // Add clientFallback hint for prod
            if(!sidecarAvailable && isProd){
                stub.clientFallback = "browser_stt";
                stub.message = "Server STT not available on Vercel — use browser SpeechRecognition";
            }
            audit.record({ businessId: req.nova.businessId, actorType: "widget", actorId: customerId, action: "echo.transcribed", detail: { stub: true, sidecarAvailable } });
            return res.json(stub);
        }
        // 1) try sidecar first (local, fast, no key)
        if (sidecarAvailable && sidecarUrl) {
            try {
                const buf = Buffer.from(body.audioBase64, "base64");
                const mimeBase = String(body.mimeType || "audio/webm").split(";")[0];
                const ext = mimeBase.split("/")[1] || "webm";
                const sideRes = await echoTranscribe.callSidecar({ sidecarUrl, audioBuffer: buf, filename: `audio.${ext}`, params });
                const crypto = require("../../lib/crypto");
                const db = require("../../db");
                const id = `ect_${crypto.randomHex(10)}`;
                db.get().prepare("INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                    .run(id, req.nova.businessId, customerId, body.conversationId || null, sideRes.language || params.language || "", sideRes.text || "", body.durationMs || 0, Date.now(), params.prompt || "", JSON.stringify(sideRes.segments?.flatMap((s) => s.words || []) || []), params.model || "tiny");
                audit.record({ businessId: req.nova.businessId, actorType: "widget", actorId: customerId, action: "echo.transcribed", detail: { language: sideRes.language, via:"sidecar" } });
                return res.json({ transcriptId: id, text: sideRes.text, language: sideRes.language, segments: sideRes.segments || [], via: "sidecar" });
            } catch (e) { console.error("sidecar transcribe failed", e.message); /* fall through */ }
        }
        // 2) OpenAI Whisper fallback — only if key is valid (prod with key)
        const hasValidKey = !!(require("../../env").ai.openaiApiKey && require("../../env").ai.openaiApiKey.startsWith("sk-") && !require("../../env").ai.openaiApiKey.includes("..."));
        if (hasValidKey) {
            try {
                const buf = Buffer.from(body.audioBase64, "base64");
                const mimeBase2 = String(body.mimeType || "audio/webm").split(";")[0];
                const ext2 = mimeBase2.split("/")[1] || "webm";
                const openRes = await echoTranscribe.callOpenAIWhisper({ audioBuffer: buf, filename: `audio.${ext2}`, language: params.language, prompt: params.prompt });
                if (openRes && openRes.text) {
                    const crypto = require("../../lib/crypto");
                    const db = require("../../db");
                    const id = `ect_${crypto.randomHex(10)}`;
                    db.get().prepare("INSERT INTO echo_transcripts (transcript_id, business_id, customer_id, conversation_id, language, transcript, duration_ms, created_at, initial_prompt, word_timestamps_json, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                        .run(id, req.nova.businessId, customerId, body.conversationId || null, openRes.language || params.language || "", openRes.text || "", body.durationMs || 0, Date.now(), params.prompt || "", "[]", "whisper-1");
                    audit.record({ businessId: req.nova.businessId, actorType: "widget", actorId: customerId, action: "echo.transcribed", detail: { language: openRes.language, via:"openai" } });
                    return res.json({ transcriptId: id, text: openRes.text, language: openRes.language || params.language, segments: [], via: "openai" });
                }
            } catch (e) { console.error("openai whisper failed", e.message); /* fall through */ }
        }
        // 3) Client fallback — tell widget to use browser STT (wasm / SpeechRecognition)
        const stub2 = echoTranscribe ? echoTranscribe.stubTranscribe({ businessId: req.nova.businessId, customerId, conversationId: body.conversationId || null, language: params.language, audioMeta, prompt: params.prompt, wordTimestamps: params.wordTimestamps, model: params.model }) : { status: "not_available" };
        stub2.clientFallback = "browser_stt";
        stub2.via = "client";
        stub2.sidecarAvailable = sidecarAvailable;
        audit.record({ businessId: req.nova.businessId, actorType: "widget", actorId: customerId, action: "echo.transcribed", detail: { stub: true, clientFallback:true, sidecarAvailable } });
        res.json(stub2);
    } catch (error) { next(error); }
});

// POST /api/v1/widget/call/handoff — customer taps "talk to human" during call/chat
router.post("/call/handoff", express.json({ limit: "1mb" }), (req, res, next) => {
    try {
        authenticateWidget(req);
        const body = req.body || {};
        const customerId = customers.validateCustomerId(body.customerId || body.customer_id) || "anonymous";
        const reason = String(body.reason || "Customer requested human").slice(0, 500);
        // record handoff request as a portal-visible call row (reuse echo calls table)
        try {
            const calls = require("../../core/echo/calls");
            calls.createCall({ businessId: req.nova.businessId, customerId, phone: body.phone || "", language: body.language || "" });
            calls.requestHandoff(calls.listCalls(req.nova.businessId, 1)[0]?.call_id);
        } catch {}
        audit.record({ businessId: req.nova.businessId, actorType: "widget", actorId: customerId, action: "call.handoff_requested", detail: { reason } });
        const cfg = configService.getConfig(req.nova.businessId);
        const contact = cfg.call?.handoffPhone || cfg.call?.handoffEmail || (require("../../core/mailer").getSettings?.(req.nova.businessId)?.contact_email) || "the business team";
        res.json({ status: "handoff_requested", contact, message: `We'll connect you with ${contact} shortly. Your request has been logged.` });
    } catch (error) { next(error); }
});

router.post("/chat", async (req, res, next) => {
    try {
        authenticateWidget(req);
        const body = req.body || {};

        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (messages.length === 0) throw badRequest("At least one message is required.");
        if (messages.length > 60) throw badRequest("Too many messages.");

        // Widget visitors are anonymous customers scoped to the embedding site.
        const customerId = customers.validateCustomerId(body.customerId) || "anonymous";

        const result = await runChat({
            businessId: req.nova.businessId,
            customerInput: { id: customerId },
            messages: messages.slice(-40),
            conversationId: body.conversationId ? String(body.conversationId).slice(0, 100) : null,
            channel: "widget",
            requestId: req.requestId,
        });

        res.json({
            success: true,
            reply: result.reply,
            conversationId: result.conversationId,
            customerId: result.customerId,
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
