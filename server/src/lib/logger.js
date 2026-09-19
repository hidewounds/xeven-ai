"use strict";

const env = require("../env");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

const SECRET_KEY_PATTERN = /pass|secret|token|api[-_]?key|integration[-_]?key|widget[-_]?key|authorization|cookie|smtp/i;

function redact(value, depth = 0) {
    if (depth > 6) return "[truncated]";
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
        // Redact anything shaped like a XEVEN key or bearer token.
        return value.replace(/xeven_pk_[a-f0-9]{8}[a-f0-9]*/gi, "xeven_pk_[redacted]");
    }

    if (Array.isArray(value)) {
        return value.map((item) => redact(item, depth + 1));
    }

    if (typeof value === "object") {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(val, depth + 1);
        }
        return out;
    }

    return value;
}

function serializeError(error) {
    if (!error) return undefined;
    return {
        name: error.name,
        message: error.message,
        status: error.status,
        code: error.code,
        stack: error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : undefined,
    };
}

function emit(level, message, context, error) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const record = {
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...(context ? { ctx: redact(context) } : {}),
        ...(error ? { err: serializeError(error) } : {}),
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
}

function createLogger(baseContext = {}) {
    return {
        child(extra) {
            return createLogger({ ...baseContext, ...extra });
        },
        debug: (msg, ctx, err) => emit("debug", msg, { ...baseContext, ...ctx }, err),
        info: (msg, ctx, err) => emit("info", msg, { ...baseContext, ...ctx }, err),
        warn: (msg, ctx, err) => emit("warn", msg, { ...baseContext, ...ctx }, err),
        error: (msg, ctx, err) => emit("error", msg, { ...baseContext, ...ctx }, err),
    };
}

const logger = createLogger();

module.exports = { logger, createLogger, redact };
