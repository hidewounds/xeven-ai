"use strict";

/**
 * Integration authentication: resolves a business from its integration key.
 * The key arrives via `x-xeven-key` header or `Authorization: Bearer <key>`.
 * Tenant identity is derived ONLY from the key — never from the body.
 * Supports scoped keys: chat:read, behavior:write, knowledge:read, admin:full
 */

const { getBusinessByKey, publicBusiness } = require("../core/config/service");
const { unauthorized, forbidden } = require("../lib/errors");
const env = require("../env");

const DEFAULT_SCOPES = ["chat:read", "behavior:write", "knowledge:read"];

function extractKey(req) {
    // COMPAT: pre-rebrand embeds send x-nova-key. Remove once migrated.
    const headerKey = req.headers["x-xeven-key"] || req.headers["x-nova-key"];
    if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();

    const authorization = req.headers["authorization"];
    if (typeof authorization === "string") {
        const match = authorization.match(/^Bearer\s+(.+)$/i);
        if (match?.[1]) return match[1].trim();
    }
    return null;
}

function parseScopes(key) {
    // In the future, scopes could be embedded in the key format: nvk_<scopes>_<random>
    // For now, use env default
    return env.integrationKeyScopes || DEFAULT_SCOPES;
}

function hasScope(key, requiredScope) {
    const scopes = parseScopes(key);
    return scopes.includes(requiredScope) || scopes.includes("admin:full");
}

function requireScope(requiredScope) {
    return (req, res, next) => {
        try {
            const key = extractKey(req);
            if (!key) throw unauthorized("XEVEN integration key is required.", "key_required");

            if (!hasScope(key, requiredScope)) {
                throw unauthorized(`Integration key missing required scope: ${requiredScope}`, "insufficient_scope");
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Restrict a route to secret/legacy integration keys. Publishable keys
 * (embedded in public website snippets) may only use the widget-scoped
 * surface: /api/v1/widget/*, /api/v1/chat, behavior ingest, business read.
 * Must run AFTER authenticateIntegration.
 */
function requireSecretKey(req, res, next) {
    try {
        if (req.xeven?.principalType === "integration" && req.xeven.keyKind === "publishable") {
            throw forbidden("This operation requires the secret integration key, not the publishable widget key.", "secret_key_required");
        }
        next();
    } catch (error) {
        next(error);
    }
}

function authenticateIntegration(req, res, next) {
    try {
        const key = extractKey(req);
        if (!key) throw unauthorized("XEVEN integration key is required.", "key_required");
        if (key.length > 500) throw unauthorized("Invalid XEVEN integration key.", "key_invalid");

        const business = getBusinessByKey(key);
        if (!business || !business.active) {
            throw unauthorized("Invalid or inactive XEVEN integration key.", "key_invalid");
        }

        req.xeven = {
            principalType: "integration",
            businessId: business.business_id,
            businessName: business.business_name,
            scopes: parseScopes(key),
            // Publishable keys are widget-scoped; secret + legacy keys keep full access.
            keyKind: business._keyKind || "legacy",
        };
        req.xevenBusiness = publicBusiness(business);
        next();
    } catch (error) {
        next(error);
    }
}

module.exports = { authenticateIntegration, extractKey, requireScope, requireSecretKey, parseScopes };
