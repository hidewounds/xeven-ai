"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Load .env from the project root regardless of cwd.
const rootEnv = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(rootEnv)) {
    require("dotenv").config({ path: rootEnv });
} else {
    require("dotenv").config();
}

const nodeEnv = String(process.env.NODE_ENV || "development").toLowerCase();

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// Persisted fallback secret so admin tokens survive restarts even without env config.
function resolveAdminSecret() {
    if (process.env.XEVEN_ADMIN_TOKEN_SECRET && process.env.XEVEN_ADMIN_TOKEN_SECRET.trim()) {
        return process.env.XEVEN_ADMIN_TOKEN_SECRET.trim();
    }
    return null; // resolved lazily against the meta table by auth/admin
}

function parseAllowedOrigins() {
    const raw = process.env.XEVEN_ALLOWED_ORIGINS;
    if (!raw) return [];
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

const env = Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: num(process.env.PORT, 3000),
    logLevel: String(process.env.XEVEN_LOG_LEVEL || (nodeEnv === "production" ? "info" : "debug")),

    dbPath: (() => {
        const raw = process.env.XEVEN_DB_PATH;
        if (!raw) return process.env.VERCEL ? "/tmp/xeven.db" : path.join(__dirname, "..", "..", "database", "xeven.db");
        // Resolve relative paths against project root, not cwd, so local runs from any directory use the same DB
        return path.isAbsolute(raw) ? raw : path.join(__dirname, "..", "..", raw);
    })(),

    corsOrigin: process.env.XEVEN_CORS_ORIGIN === "true" ? true : (process.env.XEVEN_CORS_ORIGIN || ""),
    allowedOrigins: parseAllowedOrigins(),
    maxBodyBytes: num(process.env.XEVEN_MAX_BODY_BYTES, 1_000_000),

    ai: {
        provider: String(process.env.AI_PROVIDER || "openai-compatible").toLowerCase(),
        model: process.env.XEVEN_MODEL || "gpt-4o-mini",
        openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        openaiApiKey: process.env.OPENAI_API_KEY || "",
        timeoutMs: num(process.env.XEVEN_AI_TIMEOUT_MS, 120_000),
        temperature: num(process.env.XEVEN_AI_TEMPERATURE, 0.7),
    },

    rateLimit: {
        windowMs: num(process.env.XEVEN_RATE_WINDOW_MS, 60_000),
        max: num(process.env.XEVEN_RATE_LIMIT, 120),
    },

    adminTokenTtlSec: num(process.env.XEVEN_ADMIN_TOKEN_TTL_SEC, 15 * 60), // 15min access
    adminRefreshTtlSec: num(process.env.XEVEN_ADMIN_REFRESH_TTL_SEC, 12 * 60 * 60), // 12h refresh
    adminTokenSecretFromEnv: resolveAdminSecret(),
    bootstrapSecret: process.env.XEVEN_BOOTSTRAP_SECRET || crypto.randomBytes(16).toString("hex"),

    // Integration key scopes — integration keys are business-scoped and must allow
    // the core platform operations used by the SDK and tests (chat, behavior, knowledge CRUD, tts, echo).
    integrationKeyScopes: (process.env.XEVEN_INTEGRATION_KEY_SCOPES || "chat:read,behavior:write,behavior:read,knowledge:read,knowledge:write,tts:synthesize,tts:read,echo:transcribe,echo:read").split(",").map(s => s.trim()),

    // Webhook signing
    webhookSecret: process.env.XEVEN_WEBHOOK_SECRET || "",

    // CSRF
    csrfSecret: process.env.XEVEN_CSRF_SECRET || crypto.randomBytes(32).toString("hex"),

    // Credential encryption at-rest (for model.apiKey etc.)
    credentialSecret: process.env.XEVEN_CREDENTIAL_SECRET || process.env.XEVEN_ADMIN_TOKEN_SECRET || "",

    // Redis (ready-on-setup: if XEVEN_REDIS_URL set and `redis`/`ioredis` installed, rate limit & CSRF use it; else in-mem fallback)
    redisUrl: process.env.XEVEN_REDIS_URL || process.env.REDIS_URL || "",

    // Database driver: sqlite (default, zero-config) or postgres (ready when PG env + `pg` installed)
    dbDriver: String(process.env.DB_DRIVER || "sqlite").toLowerCase(),
    pgHost: process.env.PG_HOST || "localhost",
    pgPort: num(process.env.PG_PORT, 5432),
    pgDatabase: process.env.PG_DATABASE || "xeven",
    pgUser: process.env.PG_USER || "postgres",
    pgPassword: process.env.PG_PASSWORD || "",
    pgSsl: process.env.PG_SSL === "true",

    hfToken: (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HF_API_TOKEN || "").trim(),
    hfWhisperModel: (process.env.HF_WHISPER_MODEL || "openai/whisper-large-v3").trim(),

    echoSidecarUrl: (() => {
        const u = (process.env.ECHO_SIDECAR_URL || process.env.ECHO_SIDECAR || "").trim();
        if (!u) {
            // On Vercel, no localhost sidecar exists — return empty so callers skip sidecar and use OpenAI/HF/browser fallbacks
            if (process.env.VERCEL) return "";
            return "http://127.0.0.1:8765";
        }
        // Explicit "disabled" or "none" disables sidecar (useful for Vercel)
        if (/^(none|disabled|off|false)$/i.test(u)) return "";
        return u;
    })(),

    // MeloTTS sidecar (myshell-ai/MeloTTS, MIT) — local multilingual TTS.
    // Same localhost conventions as the echo sidecar; empty on Vercel.
    meloSidecarUrl: (() => {
        const u = (process.env.XEVEN_MELO_SIDECAR_URL || process.env.MELO_SIDECAR_URL || "").trim();
        if (!u) {
            if (process.env.VERCEL) return "";
            return "http://127.0.0.1:8766";
        }
        if (/^(none|disabled|off|false)$/i.test(u)) return "";
        return u;
    })(),
});

module.exports = env;