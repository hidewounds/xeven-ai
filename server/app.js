"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");

const env = require("./src/env");
const db = require("./src/db");
const { requestContext, corsOriginValidator, securityHeaders, validateRequestSize, rateLimit, csrfProtection, csrfIssueToken, promptInjectionGuard, notFoundHandler, errorHandler } = require("./src/http/middleware");
const { startDigestCron } = require("./src/core/digests/cron");

const chatRoutes = require("./src/routes/v1/chat");
const customerRoutes = require("./src/routes/v1/customers");
const behaviorRoutes = require("./src/routes/v1/behavior");
const knowledgeRoutes = require("./src/routes/v1/knowledge");
const businessRoutes = require("./src/routes/v1/business");
const analyticsRoutes = require("./src/routes/v1/analytics");
const widgetRoutes = require("./src/routes/v1/widget");
const chronoRoutes = require("./src/routes/v1/chrono");
const echoRoutes = require("./src/routes/v1/echo");
const ttsRoutes = require("./src/routes/v1/tts");
const adminAuthRoutes = require("./src/routes/admin/auth");
const adminBusinessRoutes = require("./src/routes/admin/businesses");
const { authenticateIntegration } = require("./src/auth/integration");

/**
 * Build the fully-wired NOVA express app.
 * Exported as a factory so tests can create isolated instances.
 */
function createApp(options = {}) {
    db.init({ dbPath: options.dbPath });
    // Seed demo business for widget key so widget never 401 on fresh Vercel /tmp DB
    // Skip seeding in test mode - tests expect isolated empty DB for register flow
    try {
        if (env.nodeEnv === "test") throw new Error("skip seeding in test");
        const conn = require("./src/db/connection");
        const bizCount = conn.get().prepare("SELECT COUNT(*) as n FROM businesses").get()?.n || 0;
        if (bizCount === 0) {
            const crypto = require("./src/lib/crypto");
            const now = Date.now();
            const demoId = "nova_web_demo";
            const demoKey = "nova_pk_40d32c478e27559616acfd7827347d437b1c207d3d9f1e1c0375759d81bbb6da";
            const demoName = "NOVA Web Demo";
            try {
                conn.get().prepare("INSERT OR IGNORE INTO businesses (business_id, business_name, integration_key, active, plan, created_at, updated_at) VALUES (?, ?, ?, 1, 'unlimited', ?, ?)").run(demoId, demoName, demoKey, now, now);
                const cfg = require("./src/core/config/service");
                // ensure config exists
                const existing = conn.get().prepare("SELECT 1 FROM business_configs WHERE business_id=?").get(demoId);
                if (!existing) {
                    const normalized = cfg.normalizeConfig({}, { plan: "unlimited", bypassLimit: true });
                    conn.get().prepare("INSERT OR IGNORE INTO business_configs (business_id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run(demoId, JSON.stringify(normalized), now, now);
                }
                // ensure chrono schedule seeded via migration already, but ensure
                require("./src/db").get();
            } catch (e) { /* ignore seed errors */ }
            // Ensure demo business has portal flags enabled - otherwise portal analytics/knowledge 403 -> black screen on fresh Vercel DB
            try {
                const flags = require("./src/core/flags/store");
                const demoId = "nova_web_demo";
                const existingBiz = conn.get().prepare("SELECT business_id FROM businesses WHERE business_id=?").get(demoId);
                if (existingBiz) {
                    flags.setFlags(demoId, {
                        portal_enabled: true,
                        knowledge_edit: true,
                        edit_contact: true,
                        edit_tone: true,
                        view_analytics: true,
                        view_customers: true,
                        email_handoff: true,
                        edit_followup: true,
                        weekly_digest: true
                    });
                }
            } catch {}
        }
        // Seed / ensure demo admin + portal so Vercel /tmp DB never locks you out (page reload → just 401 otherwise)
        try {
            const crypto = require("./src/lib/crypto");
            const now = Date.now();
            const demoAdmins = [
                { email: "idk@gmail.com", pass: "Admin123!", name: "banana", isSuper: 1 },
                { email: "admin@novaweb.test", pass: "Admin123!", name: "Admin", isSuper: 1 },
            ];
            for (const a of demoAdmins) {
                const existing = conn.get().prepare("SELECT id FROM admin_users WHERE email=?").get(a.email.toLowerCase());
                const hash = crypto.hashPassword(a.pass);
                if (!existing) {
                    // Deterministic UID for Vercel ephemeral /tmp DB - ensures token from one lambda validates on another
                    const deterministicUid = "adm_" + crypto.sha256hex(a.email.toLowerCase()).slice(0, 12);
                    conn.get().prepare("INSERT INTO admin_users (admin_uid, email, name, password_hash, is_super, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(deterministicUid, a.email.toLowerCase(), a.name, hash, a.isSuper, now, now);
                } else {
                    // ensure password is the known demo one + active/super correct (so Vercel never 401 after local reset)
                    conn.get().prepare("UPDATE admin_users SET password_hash=?, is_super=?, active=1, updated_at=? WHERE email=?").run(hash, a.isSuper, now, a.email.toLowerCase());
                }
            }
            const demoPortal = { businessId: "nova_web_demo", email: "portal@novaweb.test", pass: "Portal123!" };
            const pExisting = conn.get().prepare("SELECT portal_uid FROM portal_users WHERE email=? COLLATE NOCASE").get(demoPortal.email);
            const pHash = crypto.hashPassword(demoPortal.pass);
            if (!pExisting) {
                const deterministicPid = "por_" + crypto.sha256hex(demoPortal.email.toLowerCase()).slice(0, 12);
                conn.get().prepare("INSERT INTO portal_users (portal_uid, business_id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(deterministicPid, demoPortal.businessId, demoPortal.email.toLowerCase(), pHash, now, now);
            } else {
                conn.get().prepare("UPDATE portal_users SET password_hash=?, active=1, updated_at=? WHERE email=? COLLATE NOCASE").run(pHash, now, demoPortal.email.toLowerCase());
            }
        } catch (e) { /* ignore seed errors */ }
    } catch {}

    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", true);

    // Start weekly digest cron (only in production or when explicitly enabled)
    if (env.nodeEnv === "production" || process.env.NOVA_DIGEST_CRON === "true") {
        startDigestCron();
    }

    // --- global middleware ---------------------------------------------------
    app.use(requestContext);
    app.use(corsOriginValidator);
    app.use(securityHeaders);
    // Use cors for preflight handling only; actual origin validation in corsOriginValidator
    app.use(cors({
        origin: env.corsOrigin === "true" ? true : env.corsOrigin || true,
        credentials: false,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Nova-Key", "X-CSRF-Token", "X-Request-Id"],
    }));
    app.use(express.json({ limit: env.maxBodyBytes }));
    app.use(express.urlencoded({ extended: false, limit: env.maxBodyBytes }));
    app.use(validateRequestSize);
    app.use(promptInjectionGuard);

    // Favicon - prevent 404 noise in logs
    app.get("/favicon.ico", (req, res) => res.status(204).end());

    // --- health -----------------------------------------------------------------
    app.get("/api/health", (req, res) => {
        res.json({
            ok: true,
            service: "NOVA",
            version: "1.0.0",
            environment: env.nodeEnv,
            model: env.ai.model,
            timestamp: Date.now(),
        });
    });

    // Echo sidecar health (proxied) — parity: local sidecar vs Vercel OpenAI/HF/browser
    app.get("/api/health/echo", async (req, res) => {
        try {
            const echoTranscribe = require("./src/core/echo/transcribe");
            const env = require("./src/env");
            const sidecarUrl = env.echoSidecarUrl;
            const health = sidecarUrl ? await echoTranscribe.checkSidecarHealth(sidecarUrl) : { available: false, reason: "serverless", via: "openai_hf_browser" };
            const hasOpenAI = !!(env.ai.openaiApiKey && env.ai.openaiApiKey.trim().startsWith("sk-") && env.ai.openaiApiKey.length > 20 && !env.ai.openaiApiKey.includes("..."));
            const hasHf = !!((env.hfToken || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || "").trim());
            let via = "browser_stt";
            if (hasOpenAI) via = "openai_whisper";
            else if (hasHf) via = "huggingface_whisper";
            else if (health.available) via = "sidecar";
            res.json({ sidecar: health, openai: { available: hasOpenAI, via: hasOpenAI ? "openai_whisper" : via }, huggingface: { available: hasHf, via: hasHf ? "huggingface_whisper" : via, model: env.hfWhisperModel }, browser: { via: "browser_stt", note: "Option 3: 100% guarantee via Web Speech API" }, timestamp: Date.now(), env: env.isProduction ? "production" : "development" });
        } catch (e) {
            res.json({ sidecar: { available: false, error: e.message }, timestamp: Date.now() });
        }
    });

    // CSRF token endpoint for portal - requires portal auth (Bearer) to issue token
    const portalAuthForCsrf = require("./src/auth/portal");
    app.get("/api/portal/csrf-token", rateLimit({ scope: "admin" }), portalAuthForCsrf.requirePortal, (req, res) => {
        csrfIssueToken(req, res);
    });

    // --- platform API v1 ---------------------------------------------------------
    const apiRateLimit = rateLimit();
    app.use("/api/v1/chat", chatRoutes);
    app.use("/api/v1", customerRoutes); // self-authenticating
    app.use("/api/v1", behaviorRoutes);
    app.use("/api/v1", knowledgeRoutes);
    app.use("/api/v1", businessRoutes);
    app.use("/api/v1", analyticsRoutes);
    app.use("/api/v1/chrono", chronoRoutes);
    app.use("/api/v1/echo", echoRoutes);
    app.use("/api/v1/tts", ttsRoutes);
    app.use("/api/v1/widget", apiRateLimit, widgetRoutes);
    const { publicSiteRouter } = require("./src/routes/v1/site");
    app.use("/api/v1/site", publicSiteRouter);

    // --- admin API ------------------------------------------------------------------
    app.use("/api/admin/auth", adminAuthRoutes);
    app.use("/api/admin", rateLimit({ scope: "admin" }), adminBusinessRoutes);

    // --- business portal API ----------------------------------------------------------
    const portalRoutes = require("./src/routes/portal");
    const { portalSiteRouter } = require("./src/routes/v1/site");
    // Apply CSRF protection to portal state-changing routes
    app.use("/api/portal/site", portalSiteRouter); // site analyze without CSRF? kept separate
    app.use("/api/portal", rateLimit({ scope: "admin" }), csrfProtection, portalRoutes);

    // Back-compat alias for the original integration surface.
    app.use("/api/business", authenticateIntegration, (req, res) => {
        res.status(404).json({
            error: { code: "moved", message: "Use /api/v1/business instead." },
            requestId: req.requestId,
        });
    });

    // --- static assets -------------------------------------------------------------
    const clientRoot = path.join(__dirname, "..", "client");

    app.use("/widget", express.static(path.join(clientRoot, "sdk")));
    app.use("/admin", express.static(path.join(clientRoot, "admin")));
    app.use("/portal", express.static(path.join(clientRoot, "portal")));
    app.use("/", express.static(path.join(clientRoot, "welcome")));

    // --- terminal handlers ------------------------------------------------------------
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };