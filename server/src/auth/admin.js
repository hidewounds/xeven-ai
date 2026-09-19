"use strict";

/**
 * Admin authentication: email/password admin accounts with HMAC-signed
 * bearer tokens (JWT-shaped, zero dependencies). The first registered
 * admin becomes a super-admin; subsequent admins are scoped to the
 * businesses they are granted access to.
 * 
 * Now supports: access tokens (15min) + refresh tokens (12h) with rotation
 * and revocation list.
 */

const db = require("../db").get;
const env = require("../env");
const crypto = require("../lib/crypto");
const { AppError, badRequest, unauthorized } = require("../lib/errors");
const { getBusiness, publicBusiness } = require("../core/config/service");

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{1,}$/;

// ---------------------------------------------------------------------------
// token secret bootstrap
// ---------------------------------------------------------------------------

let cachedSecret = null;

function getTokenSecret() {
    if (cachedSecret) return cachedSecret;
    if (env.adminTokenSecretFromEnv) {
        cachedSecret = env.adminTokenSecretFromEnv;
        return cachedSecret;
    }
    // On Vercel, SQLite at /tmp is ephemeral per lambda instance - a DB-stored secret would differ per instance
    // and cause tokens signed on one instance to be invalid on another (login -> immediate 401 on /me).
    // Use a stable env-derived fallback when running on Vercel without explicit XEVEN_ADMIN_TOKEN_SECRET.
    if (process.env.VERCEL) {
        const fallbackSource = process.env.XEVEN_CREDENTIAL_SECRET || "xeven-vercel-fallback-secret-CHANGE-ME-via-XEVEN_ADMIN_TOKEN_SECRET";
        cachedSecret = crypto.sha256hex(fallbackSource).slice(0, 64);
        // Ensure 64 hex chars (32 bytes) - sha256hex already 64
        if (cachedSecret.length !== 64) cachedSecret = crypto.randomHex(32);
        return cachedSecret;
    }
    const row = db().prepare(`SELECT value FROM meta WHERE key = 'admin_token_secret'`).get();
    if (row?.value) {
        cachedSecret = row.value;
        return cachedSecret;
    }
    const secret = crypto.randomHex(32);
    db().prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('admin_token_secret', ?)`).run(secret);
    cachedSecret = secret;
    return secret;
}

// ---------------------------------------------------------------------------
// revocation list (stored in meta as JSON array)
// ---------------------------------------------------------------------------

function getRevokedTokens() {
    const row = db().prepare(`SELECT value FROM meta WHERE key = 'admin_revoked_tokens'`).get();
    if (!row?.value) return new Set();
    try {
        return new Set(JSON.parse(row.value));
    } catch {
        return new Set();
    }
}

function addRevokedToken(tokenHash) {
    const revoked = getRevokedTokens();
    revoked.add(tokenHash);
    // Keep only last 10000
    if (revoked.size > 10000) {
        const arr = Array.from(revoked).slice(-10000);
        revoked.clear();
        arr.forEach(h => revoked.add(h));
    }
    db().prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('admin_revoked_tokens', ?)`).run(JSON.stringify(Array.from(revoked)));
}

function isTokenRevoked(tokenHash) {
    return getRevokedTokens().has(tokenHash);
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

function signAdminToken(admin) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + env.adminTokenTtlSec;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
        JSON.stringify({
            sub: admin.admin_uid,
            id: admin.id,
            email: admin.email,
            isSuper: Boolean(admin.is_super),
            iat: issuedAt,
            exp: expiresAt,
            type: "access",
        })
    ).toString("base64url");

    const signature = crypto.hmacSign(`${header}.${payload}`, getTokenSecret());
    return { token: `${header}.${payload}.${signature}`, expiresAt: expiresAt * 1000 };
}

function signAdminRefreshToken(admin) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + env.adminRefreshTtlSec;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
        JSON.stringify({
            sub: admin.admin_uid,
            id: admin.id,
            email: admin.email,
            isSuper: Boolean(admin.is_super),
            iat: issuedAt,
            exp: expiresAt,
            type: "refresh",
            jti: crypto.randomHex(16), // unique ID for revocation
        })
    ).toString("base64url");

    const signature = crypto.hmacSign(`${header}.${payload}`, getTokenSecret());
    return { token: `${header}.${payload}.${signature}`, expiresAt: expiresAt * 1000 };
}

function verifyAdminToken(token) {
    try {
        const parts = String(token || "").split(".");
        if (parts.length !== 3) return null;
        const [header, payload, signature] = parts;
        if (!crypto.safeEqual(crypto.hmacSign(`${header}.${payload}`, getTokenSecret()), signature)) return null;

        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!data?.sub || !data?.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
        if (data.type !== "access") return null;
        if (isTokenRevoked(crypto.sha256hex(token))) return null;
        return data;
    } catch {
        return null;
    }
}

function verifyAdminRefreshToken(token) {
    try {
        const parts = String(token || "").split(".");
        if (parts.length !== 3) return null;
        const [header, payload, signature] = parts;
        if (!crypto.safeEqual(crypto.hmacSign(`${header}.${payload}`, getTokenSecret()), signature)) return null;

        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!data?.sub || !data?.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
        if (data.type !== "refresh") return null;
        if (isTokenRevoked(crypto.sha256hex(token))) return null;
        return data;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

function publicAdmin(row) {
    if (!row) return null;
    return {
        adminUid: row.admin_uid,
        email: row.email,
        name: row.name || "",
        isSuper: Boolean(row.is_super),
        createdAt: row.created_at,
    };
}

function countAdmins() {
    return db().prepare(`SELECT COUNT(*) AS n FROM admin_users`).get().n;
}

function registerAdmin({ email, password, name }) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!EMAIL_PATTERN.test(cleanEmail)) throw badRequest("A valid email address is required.");
    if (typeof password !== "string" || password.length < 8) {
        throw badRequest("Password must be at least 8 characters.");
    }

    const existing = db().prepare(`SELECT id FROM admin_users WHERE email = ?`).get(cleanEmail);
    if (existing) throw new AppError(409, "email_taken", "An account with this email already exists.");

    const isFirst = countAdmins() === 0;
    const timestamp = Date.now();

    db()
        .prepare(
            `INSERT INTO admin_users (admin_uid, email, name, password_hash, is_super, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(crypto.randomId("adm", 10), cleanEmail, String(name || "").trim().slice(0, 200), crypto.hashPassword(password), isFirst ? 1 : 0, timestamp, timestamp);

    const row = db().prepare(`SELECT * FROM admin_users WHERE email = ?`).get(cleanEmail);
    return { admin: publicAdmin(row), isFirst, _raw: row };
}

function verifyCredentials({ email, password }) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const row = db().prepare(`SELECT * FROM admin_users WHERE email = ? AND active = 1`).get(cleanEmail);
    if (!row || !crypto.verifyPassword(password, row.password_hash)) {
        throw unauthorized("Invalid email or password.", "invalid_credentials");
    }
    return row;
}

function getByUid(uid) {
    return (
        db()
            .prepare(`SELECT * FROM admin_users WHERE admin_uid = ? AND active = 1`)
            .get(String(uid || "")) || null
    );
}

// ---------------------------------------------------------------------------
// access control
// ---------------------------------------------------------------------------

function grantBusinessAccess(adminId, businessId) {
    db()
        .prepare(`INSERT OR IGNORE INTO admin_business_access (admin_id, business_id, granted_at) VALUES (?, ?, ?)`)
        .run(adminId, businessId, Date.now());
}

function canAccessBusiness(adminRow, businessId) {
    if (adminRow.is_super) return true;
    const row = db()
        .prepare(`SELECT 1 AS ok FROM admin_business_access WHERE admin_id = ? AND business_id = ?`)
        .get(adminRow.id, String(businessId));
    return Boolean(row);
}

function listAccessibleBusinesses(adminRow) {
    if (adminRow.is_super) {
        const rows = db().prepare(`SELECT * FROM businesses ORDER BY created_at ASC`).all();
        return rows.map(publicBusiness);
    }
    const rows = db()
        .prepare(
            `SELECT b.* FROM businesses b
             JOIN admin_business_access a ON a.business_id = b.business_id
             WHERE a.admin_id = ?
             ORDER BY b.created_at ASC`
        )
        .all(adminRow.id);
    return rows.map(publicBusiness);
}

// ---------------------------------------------------------------------------
// middleware
// ---------------------------------------------------------------------------

function parseCookies(req) {
    const out = {};
    const header = req.headers["cookie"];
    if (typeof header !== "string" || !header) return out;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) out[name] = decodeURIComponent(value);
    }
    return out;
}

const ADMIN_COOKIE = "xeven_admin_token";
const ADMIN_REFRESH_COOKIE = "xeven_admin_refresh";

function cookieFlags(maxAgeMs, { refreshPath = false } = {}) {
    // SameSite=Lax blocks cross-site POST CSRF by default; Secure only in
    // production so plain-http localhost development keeps working.
    const flags = [`Path=${refreshPath ? "/api/admin/auth" : "/"}`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`, "HttpOnly", "SameSite=Lax"];
    if (env.isProduction) flags.push("Secure");
    return flags.join("; ");
}

function setAdminCookies(res, access, refresh) {
    res.append("Set-Cookie", `${ADMIN_COOKIE}=${encodeURIComponent(access.token)}; ${cookieFlags(env.adminTokenTtlSec * 1000)}`);
    res.append("Set-Cookie", `${ADMIN_REFRESH_COOKIE}=${encodeURIComponent(refresh.token)}; ${cookieFlags(env.adminRefreshTtlSec * 1000, { refreshPath: true })}`);
}

function clearAdminCookies(res) {
    const expired = "Max-Age=0; HttpOnly; SameSite=Lax; Path=/";
    const expiredAuth = "Max-Age=0; HttpOnly; SameSite=Lax; Path=/api/admin/auth";
    res.append("Set-Cookie", `${ADMIN_COOKIE}=; ${expired}`);
    res.append("Set-Cookie", `${ADMIN_REFRESH_COOKIE}=; ${expiredAuth}`);
}

// --- stateless CSRF tokens for cookie-authed admin mutations ----------------
// Bearer-authed requests skip CSRF (browsers can't auto-send Authorization
// cross-origin). Cookie-authed mutations must present X-CSRF-Token.
function adminCsrfToken(adminUid) {
    const day = new Date().toISOString().slice(0, 10);
    const mac = crypto.hmacSign(`${adminUid}.${day}`, env.csrfSecret);
    return `${day}.${mac}`;
}

function verifyAdminCsrf(token, adminUid) {
    try {
        const [day, mac] = String(token || "").split(".");
        if (!day || !mac) return false;
        const days = [day];
        const d = new Date(`${day}T00:00:00Z`);
        if (!Number.isNaN(d.getTime())) days.push(new Date(d.getTime() - 86400000).toISOString().slice(0, 10));
        return days.some((dd) => crypto.safeEqual(mac, crypto.hmacSign(`${adminUid}.${dd}`, env.csrfSecret)));
    } catch {
        return false;
    }
}

function requireAdminCsrf(req, res, next) {
    try {
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
        const authorization = req.headers["authorization"];
        if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) return next();
        const cookies = parseCookies(req);
        if (!cookies[ADMIN_COOKIE]) return next(); // no cookie session → nothing to forge
        const token = req.headers["x-csrf-token"] || req.body?.csrf_token;
        if (!token || !verifyAdminCsrf(token, req.xeven?.adminUid)) {
            throw new AppError(403, "csrf_invalid", "Invalid or missing CSRF token.");
        }
        next();
    } catch (error) {
        next(error);
    }
}

function requireAdmin(req, res, next) {
    try {
        const authorization = req.headers["authorization"];
        const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
        const token = match?.[1] || parseCookies(req)[ADMIN_COOKIE] || null;
        if (!token) throw unauthorized("Admin authentication required.", "admin_token_required");

        const payload = verifyAdminToken(token);
        if (!payload) throw unauthorized("Invalid or expired admin token.", "admin_token_invalid");

        const admin = getByUid(payload.sub);
        if (!admin) throw unauthorized("Admin account is inactive.", "admin_inactive");

        req.xeven = { principalType: "admin", adminId: admin.id, adminUid: admin.admin_uid, isSuper: Boolean(admin.is_super) };
        req.xevenAdmin = { ...publicAdmin(admin), password_hash: undefined };
        next();
    } catch (error) {
        next(error);
    }
}

/** Load :businessId param and enforce that the admin may touch it. */
function loadOwnedBusiness(req, res, next) {
    try {
        const businessId = String(req.params.businessId || "").trim();
        const business = getBusiness(businessId);
        if (!business) throw new AppError(404, "not_found", "Business not found.");

        // Super admins bypass; otherwise explicit grant required.
        if (!canAccessBusiness(db().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId), business.business_id)) {
            throw new AppError(403, "forbidden", "You do not have access to this business.");
        }

        req.xeven.businessId = business.business_id;
        req.xevenBusiness = publicBusiness(business, { includeKey: true });
        next();
    } catch (error) {
        next(error);
    }
}

module.exports = {
    registerAdmin,
    verifyCredentials,
    getByUid,
    publicAdmin,
    signAdminToken,
    signAdminRefreshToken,
    verifyAdminToken,
    verifyAdminRefreshToken,
    addRevokedToken,
    parseCookies,
    setAdminCookies,
    clearAdminCookies,
    adminCsrfToken,
    verifyAdminCsrf,
    requireAdminCsrf,
    ADMIN_COOKIE,
    ADMIN_REFRESH_COOKIE,
    grantBusinessAccess,
    canAccessBusiness,
    listAccessibleBusinesses,
    requireAdmin,
    loadOwnedBusiness,
};