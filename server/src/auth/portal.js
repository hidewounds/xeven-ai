"use strict";

/**
 * Business-portal authentication. A portal user belongs to EXACTLY ONE
 * business and can only ever see that business's data — enforced here, not
 * in the UI.
 * 
 * Now supports: sliding expiration (extend on activity), explicit logout
 */

const crypto = require("crypto");
const db = require("../db").get;
const env = require("../env");
const libCrypto = require("../lib/crypto");
const { badRequest, unauthorized, AppError } = require("../lib/errors");
const flags = require("../core/flags/store");

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const SLIDING_WINDOW_MS = 30 * 60 * 1000; // extend if within 30min of expiry

function getTokenSecret() {
    // Prefer env secret for consistency with admin (stable across Vercel lambdas)
    let secret = env.adminTokenSecretFromEnv || process.env.XEVEN_ADMIN_TOKEN_SECRET;
    if (secret) return secret;
    // On Vercel, /tmp DB is ephemeral per lambda - avoid per-instance random secret which breaks cross-instance validation
    if (process.env.VERCEL) {
        const fallbackSource = process.env.XEVEN_CREDENTIAL_SECRET || "xeven-vercel-fallback-secret-CHANGE-ME-via-XEVEN_ADMIN_TOKEN_SECRET";
        return libCrypto.sha256hex ? libCrypto.sha256hex(fallbackSource).slice(0, 64) : require("crypto").createHash("sha256").update(String(fallbackSource)).digest("hex");
    }
    const row = db().prepare("SELECT value FROM meta WHERE key = 'portal_token_secret'").get();
    if (row) secret = row.value;
    else {
        secret = libCrypto.randomHex(32);
        db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('portal_token_secret', ?)").run(secret);
    }
    return secret;
}

function signPortalToken(user) {
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const payload = `${user.portal_uid}.${user.business_id}.${expiresAt}`;
    const sig = libCrypto.hmacSign(payload, getTokenSecret());
    return { token: `${Buffer.from(payload).toString("base64url")}.${sig}`, expiresAt };
}

function verifyPortalToken(token) {
    try {
        const [payloadB64, sig] = String(token || "").split(".");
        if (!payloadB64 || !sig) return null;
        const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
        const expected = libCrypto.hmacSign(payload, getTokenSecret());
        if (!libCrypto.safeEqual(sig, expected)) return null;

        const [portalUid, businessId, expiresAt] = payload.split(".");
        if (!portalUid || !businessId || Number(expiresAt) < Date.now()) return null;
        return { portalUid, businessId, expiresAt: Number(expiresAt) };
    } catch {
        return null;
    }
}

function publicUser(row) {
    return {
        portalUid: row.portal_uid,
        businessId: row.business_id,
        email: row.email,
        active: Boolean(row.active),
    };
}

function registerPortalUser({ businessId, email, password }) {
    if (!businessId) throw badRequest("businessId is required.");
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw badRequest("A valid email is required.");
    if (!password || String(password).length < 8) throw badRequest("Password must be at least 8 characters.");

    const existsBusiness = db().prepare("SELECT 1 FROM businesses WHERE business_id = ?").get(businessId);
    if (!existsBusiness) throw new AppError(404, "not_found", "Business not found.");

    const uid = libCrypto.randomId("por");
    const t = Date.now();
    db().prepare(
        `INSERT INTO portal_users (portal_uid, business_id, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uid, businessId, cleanEmail, libCrypto.hashPassword(password), t, t);

    return getPortalUserByUid(uid);
}

function getPortalUserByUid(uid) {
    const row = db().prepare("SELECT * FROM portal_users WHERE portal_uid = ? AND active = 1").get(uid);
    return row || null;
}

function verifyCredentials({ email, password }) {
    if (!email || !password) throw badRequest("Email and password are required.");
    const cleanEmail = String(email).trim().toLowerCase();
    if (!cleanEmail) throw badRequest("Email and password are required.");
    const row = db()
        .prepare("SELECT * FROM portal_users WHERE email = ? COLLATE NOCASE AND active = 1")
        .get(cleanEmail);
    if (!row || !libCrypto.verifyPassword(password, row.password_hash)) {
        throw unauthorized("Invalid portal credentials.", "portal_credentials_invalid");
    }
    return row;
}

function parsePortalCookies(req) {
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

const PORTAL_COOKIE = "xeven_portal_token";

function setPortalCookie(res, token) {
    const flags = [`Path=/`, `Max-Age=${12 * 60 * 60}`, "HttpOnly", "SameSite=Lax"];
    if (env.isProduction) flags.push("Secure");
    res.append("Set-Cookie", `${PORTAL_COOKIE}=${encodeURIComponent(token)}; ${flags.join("; ")}`);
}

function clearPortalCookie(res) {
    res.append("Set-Cookie", `${PORTAL_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/`);
}

/** Express middleware: authenticates a portal user + loads flags & settings. */
function requirePortal(req, res, next) {
    try {
        const match = String(req.headers["authorization"] || "").match(/^Bearer\s+(.+)$/i);
        const token = match?.[1] || req.query.token || parsePortalCookies(req)[PORTAL_COOKIE] || null;
        if (!token) throw unauthorized("Portal authentication required.", "portal_token_required");

        const payload = verifyPortalToken(token);
        if (!payload) throw unauthorized("Invalid or expired portal token.", "portal_token_invalid");

        const user = getPortalUserByUid(payload.portalUid);
        if (!user || user.business_id !== payload.businessId) throw unauthorized("Portal account is inactive.", "portal_inactive");

        // Sliding expiration: if token expires within SLIDING_WINDOW_MS, issue new token
        const shouldRefresh = payload.expiresAt - Date.now() < SLIDING_WINDOW_MS;
        let newToken = null;
        if (shouldRefresh) {
            newToken = signPortalToken(user);
            // Set header for client to update
            res.setHeader("X-Portal-Token-Refresh", newToken.token);
        }

        req.xeven = {
            principalType: "portal",
            portalUid: user.portal_uid,
            businessId: user.business_id,
            isSuper: false,
        };
        req.xevenPortal = publicUser(user);
        req.xevenFlags = flags.getFlags(user.business_id);
        req.xevenPortalTokenRefresh = newToken;
        next();
    } catch (error) {
        next(error);
    }
}

/** Gate any portal capability behind its founder-controlled flag. */
function requireFlag(flagName) {
    return (req, res, next) => {
        try {
            if (!req.xevenFlags || req.xevenFlags[flagName] !== true) {
                throw new AppError(403, "feature_disabled", `This capability is disabled for your business ("${flagName}").`);
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    registerPortalUser,
    verifyCredentials,
    signPortalToken,
    verifyPortalToken,
    getPortalUserByUid,
    publicUser,
    requirePortal,
    requireFlag,
    parsePortalCookies,
    setPortalCookie,
    clearPortalCookie,
    PORTAL_COOKIE,
};