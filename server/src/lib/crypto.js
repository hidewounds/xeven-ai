"use strict";

const crypto = require("crypto");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function randomHex(bytes = 32) {
    return crypto.randomBytes(bytes).toString("hex");
}

function randomId(prefix = "id", bytes = 12) {
    return `${prefix}_${randomHex(bytes)}`;
}

function sha256hex(value) {
    return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function generateIntegrationKey() {
    return `xeven_pk_${randomHex(32)}`;
}

/**
 * Split credentials: the website snippet embeds the PUBLISHABLE key
 * (widget-scoped only), while the SECRET key stays in the dashboard/API.
 * Legacy `xeven_pk_<64hex>` keys keep full access (backward compatible).
 */
function generatePublishableKey() {
    return `xeven_pk_pub_${randomHex(16)}`;
}

function generateSecretKey() {
    return `xeven_pk_sec_${randomHex(32)}`;
}

function derivePublishableKey(secretKey) {
    return `xeven_pk_pub_${sha256hex(secretKey).slice(0, 32)}`;
}

function classifyIntegrationKey(key) {
    // COMPAT: pre-rebrand keys map onto current kinds. Remove once migrated.
    const k = String(key || "").trim().replace(/^nova_pk_/, "xeven_pk_");
    if (/^xeven_pk_pub_[0-9a-f]{32}$/.test(k)) return "publishable";
    if (/^xeven_pk_sec_[0-9a-f]{64}$/.test(k)) return "secret";
    if (/^xeven_pk_[0-9a-f]{64}$/.test(k)) return "legacy";
    return "unknown";
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
    try {
        const parts = String(stored || "").split("$");
        if (parts.length !== 6 || parts[0] !== "scrypt") return false;
        const [, n, r, p, saltHex, hashHex] = parts;
        const expected = Buffer.from(hashHex, "hex");
        const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length, {
            N: Number(n), r: Number(r), p: Number(p),
        });
        return crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

function hmacSign(data, secret) {
    return crypto.createHmac("sha256", secret).update(String(data)).digest("base64url");
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a ?? ""));
    const bufB = Buffer.from(String(b ?? ""));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// --- reversible encryption for stored credentials (business SMTP passwords) ---
// In production a real XEVEN_CREDENTIAL_SECRET must be set (see env.js validation).
// The development fallback below is intentionally weak and must never be used with
// real credentials — it only keeps local `npm run dev` zero-config.

function _encryptionKey() {
    const fromEnv = process.env.XEVEN_CREDENTIAL_SECRET || process.env.XEVEN_ADMIN_TOKEN_SECRET || "";
    const secret = fromEnv || (process.env.NODE_ENV === "production" ? "" : "xeven-local-development-secret");
    if (!secret) throw new Error("XEVEN_CREDENTIAL_SECRET (or XEVEN_ADMIN_TOKEN_SECRET) must be set in production");
    return crypto.createHash("sha256").update(String(secret)).digest();
}

/** AES-256-GCM. Returns iv:tag:cipher (all hex). */
function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", _encryptionKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plaintext ?? ""), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(payload) {
    try {
        const [ivHex, tagHex, dataHex] = String(payload || "").split(":");
        if (!ivHex || !tagHex || !dataHex) return "";
        const decipher = crypto.createDecipheriv("aes-256-gcm", _encryptionKey(), Buffer.from(ivHex, "hex"));
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
    } catch {
        return "";
    }
}

module.exports = {
    randomHex,
    randomId,
    sha256hex,
    generateIntegrationKey,
    generatePublishableKey,
    generateSecretKey,
    derivePublishableKey,
    classifyIntegrationKey,
    hashPassword,
    verifyPassword,
    hmacSign,
    safeEqual,
    encrypt,
    decrypt,
};
