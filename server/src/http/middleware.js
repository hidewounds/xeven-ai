"use strict";

const env = require("../env");
const { randomId } = require("../lib/crypto");
const { createLogger } = require("../lib/logger");
const { AppError, payloadTooLarge, tooManyRequests } = require("../lib/errors");

// ---------------------------------------------------------------------------
// request context + access log
// ---------------------------------------------------------------------------

function requestContext(req, res, next) {
    const requestId = req.headers["x-request-id"] || randomId("req", 10);
    req.requestId = requestId;
    req.log = createLogger({ requestId });
    res.setHeader("X-Request-Id", requestId);

    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        req.log.info("request", {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(durationMs * 10) / 10,
            businessId: req.xeven?.businessId || undefined,
        });
    });

    next();
}

// ---------------------------------------------------------------------------
// CORS origin validation
// ---------------------------------------------------------------------------

function corsOriginValidator(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser requests (curl, server-to-server)

    // Public embed surfaces must work on ANY customer domain — never block widget/tracker.
    // These endpoints are already authenticated via x-xeven-key / key in body, not origin.
    const publicEmbedPrefixes = [
        "/api/v1/widget",
        "/api/v1/behavior",
        "/api/v1/chat", // widget chat also public-key authed
        "/widget/",
        "/widget",
        "/api/health",
    ];
    const isPublicEmbed = publicEmbedPrefixes.some((p) => req.path === p || req.path.startsWith(p + "/") || req.path.startsWith(p));
    if (isPublicEmbed) {
        // Reflect origin permissively for embed surfaces
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "false");
        return next();
    }

    const allowed = env.allowedOrigins;
    if (allowed.length === 0) {
        // No explicit allowlist configured
        if (env.isProduction) {
            // Same-origin (admin/portal served from same host) must be allowed — otherwise browser POST with Origin is blocked
            const host = String(req.headers.host || "");
            const originHost = (() => { try { return new URL(origin).host; } catch { return ""; } })();
            const isSameHost = originHost && host && originHost === host;
            const isVercelProd = origin.includes("vercel.app") || origin.includes("xeven-ai") || isSameHost;
            if (isSameHost || isVercelProd) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Vary", "Origin");
                res.setHeader("Access-Control-Allow-Credentials", "false");
                return next();
            }
            return res.status(403).json({
                error: { code: "cors_forbidden", message: "Origin not allowed. Configure XEVEN_ALLOWED_ORIGINS to allow your dashboard/API origins." },
                requestId: req.requestId,
            });
        }
        // Dev: reflect origin permissively
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        return next();
    }

    if (!allowed.includes(origin)) {
        return res.status(403).json({
            error: { code: "cors_forbidden", message: "Origin not allowed." },
            requestId: req.requestId,
        });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    next();
}

// ---------------------------------------------------------------------------
// security headers
// ---------------------------------------------------------------------------

function securityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Echo voice needs microphone on widget/portal surfaces; keep geolocation locked
    const allowMic = req.path && (req.path.startsWith("/widget") || req.path.startsWith("/portal") || req.path.startsWith("/api/v1/widget") || req.path.startsWith("/api/portal"));
    res.setHeader("Permissions-Policy", allowMic ? "camera=(), microphone=(self), geolocation=()" : "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cache-Control", "no-store");
    if (env.isProduction) {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    // CSP for admin/portal static assets
    if (req.path.startsWith("/admin") || req.path.startsWith("/portal")) {
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    next();
}

// ---------------------------------------------------------------------------
// body size guard
// ---------------------------------------------------------------------------

function validateRequestSize(req, res, next) {
    const contentLength = Number(req.headers["content-length"]);
    // voice uploads need more headroom than default 1MB; allow up to 12MB for echo paths
    const isVoiceUpload = req.path && (req.path.includes("/transcribe") || req.path.includes("/echo"));
    const limit = isVoiceUpload ? Math.max(env.maxBodyBytes, 12_000_000) : env.maxBodyBytes;
    if (Number.isFinite(contentLength) && contentLength > limit) {
        return next(payloadTooLarge());
    }
    next();
}

// ---------------------------------------------------------------------------
// CSRF protection (double-submit) — ready-on-setup: Redis if available, else in-mem Map
// ---------------------------------------------------------------------------

const csrfTokens = new Map(); // token -> { businessId, createdAt }

// Optional Redis for CSRF/rate-limit (idle until XEVEN_REDIS_URL + `ioredis`/`redis` installed)
let redisClient = null;
let redisReady = false;
(function initRedis() {
    if (!env.redisUrl) return;
    try {
        let RedisLib = null;
        try { RedisLib = require("ioredis"); } catch {}
        if (RedisLib) {
            redisClient = new RedisLib(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
            redisClient.on("ready", () => { redisReady = true; });
            redisClient.on("error", () => { redisReady = false; });
            redisClient.connect().catch(() => { redisClient = null; redisReady = false; });
            return;
        }
    } catch {}
    try {
        const { createClient } = require("redis");
        redisClient = createClient({ url: env.redisUrl });
        redisClient.on("ready", () => { redisReady = true; });
        redisClient.on("error", () => { redisReady = false; });
        redisClient.connect().catch(() => { redisClient = null; redisReady = false; });
    } catch {
        redisClient = null;
    }
})();

async function generateCsrfToken(businessId) {
    const token = randomId("csrf", 32);
    // Try Redis first (1h TTL)
    if (redisClient && redisReady) {
        try { await redisClient.set(`csrf:${token}`, String(businessId), "EX", 3600); return token; } catch {}
    }
    csrfTokens.set(token, { businessId, createdAt: Date.now() });
    return token;
}

async function validateCsrfToken(token, businessId) {
    if (redisClient && redisReady) {
        try {
            const stored = await redisClient.get(`csrf:${token}`);
            if (!stored) return false;
            return String(stored) === String(businessId);
        } catch {}
    }
    const entry = csrfTokens.get(token);
    if (!entry) return false;
    if (entry.businessId !== businessId) return false;
    if (Date.now() - entry.createdAt > 3600_000) {
        csrfTokens.delete(token);
        return false;
    }
    return true;
}

async function csrfProtection(req, res, next) {
    // Use originalUrl because when mounted at /api/portal, req.path is stripped (e.g. "/settings" not "/api/portal/settings")
    const url = req.originalUrl || req.url || "";
    const pathOnly = url.split("?")[0];
    const isPortalMutation = pathOnly.startsWith("/api/portal") && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (!isPortalMutation) return next();
    // Public portal auth never needs CSRF - otherwise login is blocked (chicken-egg).
    // Logout is exempt too (worst case is an attacker logging the victim out).
    if (pathOnly === "/api/portal/auth/login" || pathOnly.startsWith("/api/portal/auth/login?")) return next();
    if (pathOnly === "/api/portal/auth/logout" || pathOnly.startsWith("/api/portal/auth/logout?")) return next();
    // Bearer token auth (admin & portal dashboard use Authorization: Bearer ...) is not CSRF-vulnerable
    // (browser cannot auto-send Authorization header cross-origin). Skip CSRF for Bearer to keep dashboard working
    // without requiring client to fetch/attach X-CSRF-Token.
    const auth = req.headers["authorization"] || req.headers["Authorization"];
    if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return next();
    const token = req.headers["x-csrf-token"] || req.body?.csrf_token;
    const ok = token ? await validateCsrfToken(token, req.xeven?.businessId) : false;
    if (!ok) {
        return res.status(403).json({
            error: { code: "csrf_invalid", message: "Invalid or missing CSRF token." },
            requestId: req.requestId,
        });
    }
    next();
}

// Endpoint to issue CSRF tokens for portal
async function csrfIssueToken(req, res) {
    if (!req.xeven?.businessId) {
        return res.status(401).json({ error: { code: "unauthorized", message: "Authentication required." } });
    }
    const token = await generateCsrfToken(req.xeven.businessId);
    res.json({ csrf_token: token });
}

// ---------------------------------------------------------------------------
// rate limiting — ready-on-setup: Redis sliding window if available, else in-mem Map
// ---------------------------------------------------------------------------

const buckets = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now - bucket.startedAt > env.rateLimit.windowMs * 2) buckets.delete(key);
    }
}, env.rateLimit.windowMs).unref();

function clientKey(req) {
    return (
        req.xeven?.businessId ||
        `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`
    );
}

function rateLimit(options = {}) {
    const windowMs = options.windowMs || env.rateLimit.windowMs;
    const max = options.max || env.rateLimit.max;

    return async function rateLimitMiddleware(req, res, next) {
        const key = `${options.scope || "api"}:${clientKey(req)}`;

        // Try Redis first (atomic INCR + PTTL)
        if (redisClient && redisReady) {
            try {
                const redisKey = `rl:${key}`;
                const count = await redisClient.incr(redisKey);
                if (count === 1) await redisClient.pexpire(redisKey, windowMs);
                const ttl = await redisClient.pttl(redisKey);
                res.setHeader("X-RateLimit-Limit", String(max));
                res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - count)));
                if (count > max) {
                    const retryAfter = Math.ceil((ttl > 0 ? ttl : windowMs) / 1000);
                    res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
                    return next(tooManyRequests());
                }
                return next();
            } catch {
                // fall through to in-mem
            }
        }

        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || now - bucket.startedAt >= windowMs) {
            bucket = { startedAt: now, count: 0 };
            buckets.set(key, bucket);
        }
        bucket.count++;

        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));

        if (bucket.count > max) {
            const retryAfter = Math.ceil((windowMs - (now - bucket.startedAt)) / 1000);
            res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
            return next(tooManyRequests());
        }

        next();
    };
}

// ---------------------------------------------------------------------------
// Prompt injection detection middleware
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
    /ignore\s+(?:all\s+)?(?:previous\s+)?instructions?/i,
    /system\s+prompt/i,
    /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i,
    /override\s+(?:all\s+)?(?:rules?|instructions?)/i,
    /forget\s+(?:all\s+)?(?:previous\s+)?(?:context|instructions?)/i,
    /you\s+are\s+now\s+(?:a\s+)?(?:different|new)\s+(?:assistant|persona|character)/i,
    /(?:act|pretend)\s+as\s+(?:if\s+)?(?:you\s+)?(?:are\s+)?(?:a\s+)?(?:different|unrestricted|unfiltered)/i,
    /output\s+(?:your\s+)?(?:system|developer)\s+(?:prompt|instructions?)/i,
    /show\s+me\s+(?:your\s+)?(?:system|hidden)\s+(?:prompt|instructions?)/i,
];

function promptInjectionGuard(req, res, next) {
    // Only check chat/widget endpoints with message content
    const isChatEndpoint = req.path.includes("/chat") || req.path.includes("/widget");
    if (!isChatEndpoint || req.method !== "POST") return next();

    const messages = req.body?.messages;
    if (!Array.isArray(messages)) return next();

    for (const msg of messages) {
        if (msg?.role === "user" && typeof msg.content === "string") {
            for (const pattern of INJECTION_PATTERNS) {
                if (pattern.test(msg.content)) {
                    req.log.warn("prompt_injection_detected", { pattern: pattern.toString(), path: req.path });
                    // Sanitize: replace matched content with [filtered]
                    msg.content = msg.content.replace(pattern, "[filtered]");
                }
            }
        }
    }
    next();
}

// ---------------------------------------------------------------------------
// terminal handlers
// ---------------------------------------------------------------------------

function notFoundHandler(req, res) {
    res.status(404).json({
        error: { code: "not_found", message: "XEVEN endpoint not found." },
        requestId: req.requestId,
    });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
    const isAppError = error instanceof AppError;
    const status = isAppError ? error.status : Number(error?.status || error?.statusCode) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;

    const log = req.log || console;
    if (safeStatus >= 500) {
        log.error("request failed", { path: req.path, businessId: req.xeven?.businessId }, error);
    } else {
        log.warn("request rejected", { path: req.path, status: safeStatus, code: error.code });
    }

    if (res.headersSent) return;

    const expose = isAppError ? error.expose : safeStatus < 500 && Boolean(error.publicMessage || error.message);
    let message =
        safeStatus === 500
            ? "Internal XEVEN server error."
            : expose
                ? error.publicMessage || error.message
                : "Request failed.";

    // Sanitize error messages in production
    if (env.isProduction && safeStatus === 500) {
        message = "Internal server error.";
    }

    res.status(safeStatus).json({
        error: { code: error.code || (safeStatus === 500 ? "internal_error" : "request_failed"), message },
        requestId: req.requestId,
    });
}

module.exports = {
    requestContext,
    corsOriginValidator,
    securityHeaders,
    validateRequestSize,
    rateLimit,
    csrfProtection,
    csrfIssueToken,
    promptInjectionGuard,
    notFoundHandler,
    errorHandler,
};