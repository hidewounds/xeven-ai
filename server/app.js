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
 * Build the fully-wired XEVEN express app.
 * Exported as a factory so tests can create isolated instances.
 */
function createApp(options = {}) {
    db.init({ dbPath: options.dbPath });
    // No demo seeding: first boot starts empty. Register the first admin
    // account at /admin/ (it becomes super-admin), then create a business
    // to receive its publishable + secret integration keys.

    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", true);

    // Start weekly digest cron (only in production or when explicitly enabled)
    if (env.nodeEnv === "production" || process.env.XEVEN_DIGEST_CRON === "true") {
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
        allowedHeaders: ["Content-Type", "Authorization", "X-Xeven-Key", "X-CSRF-Token", "X-Request-Id"],
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
            service: "XEVEN",
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

    // COMPAT (pre-rebrand embeds): old snippet filenames redirect to the
    // current ones. Remove once embeds migrate.
    app.get(["/widget/nova-widget.js", "/widget/nova-tracker.js", "/widget/nova-guide.js"], (req, res) => {
        res.redirect(301, `/widget/${req.path.split("/").pop().replace(/^nova-/, "xeven-")}`);
    });
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