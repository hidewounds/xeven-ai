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
    if (process.env.NOVA_ADMIN_TOKEN_SECRET && process.env.NOVA_ADMIN_TOKEN_SECRET.trim()) {
        return process.env.NOVA_ADMIN_TOKEN_SECRET.trim();
    }
    return null; // resolved lazily against the meta table by auth/admin
}

function parseAllowedOrigins() {
    const raw = process.env.NOVA_ALLOWED_ORIGINS;
    if (!raw) return [];
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

const env = Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: num(process.env.PORT, 3000),
    logLevel: String(process.env.NOVA_LOG_LEVEL || (nodeEnv === "production" ? "info" : "debug")),

    dbPath: (() => {
        const raw = process.env.NOVA_DB_PATH;
        if (!raw) return process.env.VERCEL ? "/tmp/nova.db" : path.join(__dirname, "..", "..", "database", "nova.db");
        // Resolve relative paths against project root, not cwd, so local runs from any directory use the same DB
        return path.isAbsolute(raw) ? raw : path.join(__dirname, "..", "..", raw);
    })(),

    corsOrigin: process.env.NOVA_CORS_ORIGIN === "true" ? true : (process.env.NOVA_CORS_ORIGIN || ""),
    allowedOrigins: parseAllowedOrigins(),
    maxBodyBytes: num(process.env.NOVA_MAX_BODY_BYTES, 1_000_000),

    ai: {
        provider: String(process.env.AI_PROVIDER || "ollama").toLowerCase(),
        model: process.env.NOVA_MODEL || "qwen2.5:3b-instruct",
        ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
        openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        openaiApiKey: process.env.OPENAI_API_KEY || "",
        timeoutMs: num(process.env.NOVA_AI_TIMEOUT_MS, 120_000),
        temperature: num(process.env.NOVA_AI_TEMPERATURE, 0.7),
    },

    rateLimit: {
        windowMs: num(process.env.NOVA_RATE_WINDOW_MS, 60_000),
        max: num(process.env.NOVA_RATE_LIMIT, 120),
    },

    adminTokenTtlSec: num(process.env.NOVA_ADMIN_TOKEN_TTL_SEC, 15 * 60), // 15min access
    adminRefreshTtlSec: num(process.env.NOVA_ADMIN_REFRESH_TTL_SEC, 12 * 60 * 60), // 12h refresh
    adminTokenSecretFromEnv: resolveAdminSecret(),
    bootstrapSecret: process.env.NOVA_BOOTSTRAP_SECRET || crypto.randomBytes(16).toString("hex"),

    // Integration key scopes — integration keys are business-scoped and must allow
    // the core platform operations used by the SDK and tests (chat, behavior, knowledge CRUD, tts, echo).
    integrationKeyScopes: (process.env.NOVA_INTEGRATION_KEY_SCOPES || "chat:read,behavior:write,behavior:read,knowledge:read,knowledge:write,tts:synthesize,tts:read,echo:transcribe,echo:read").split(",").map(s => s.trim()),

    // Webhook signing
    webhookSecret: process.env.NOVA_WEBHOOK_SECRET || "",

    // CSRF
    csrfSecret: process.env.NOVA_CSRF_SECRET || crypto.randomBytes(32).toString("hex"),

    // Credential encryption at-rest (for model.apiKey etc.)
    credentialSecret: process.env.NOVA_CREDENTIAL_SECRET || process.env.NOVA_ADMIN_TOKEN_SECRET || "",

    // Redis (ready-on-setup: if NOVA_REDIS_URL set and `redis`/`ioredis` installed, rate limit & CSRF use it; else in-mem fallback)
    redisUrl: process.env.NOVA_REDIS_URL || process.env.REDIS_URL || "",

    // Database driver: sqlite (default, zero-config) or postgres (ready when PG env + `pg` installed)
    dbDriver: String(process.env.DB_DRIVER || "sqlite").toLowerCase(),
    pgHost: process.env.PG_HOST || "localhost",
    pgPort: num(process.env.PG_PORT, 5432),
    pgDatabase: process.env.PG_DATABASE || "nova",
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
});

module.exports = env;