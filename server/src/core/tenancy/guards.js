"use strict";

/**
 * Multi-tenancy runtime guards.
 * Runtime assertions that enforce tenant isolation at critical paths.
 * These are cheap checks that run on every request to catch isolation bugs early.
 */

const { AppError } = require("../../lib/errors");

/**
 * Assert that a businessId matches the expected tenant context.
 * Throws if the businessId doesn't match the authenticated context.
 */
function assertTenantContext(requestBusinessId, expectedBusinessId, operation = "operation") {
    const expected = normalizeBusinessId(expectedBusinessId);
    const actual = normalizeBusinessId(requestBusinessId);
    
    if (actual !== expected) {
        throw new AppError(
            403,
            "tenant_isolation_violation",
            `Tenant isolation violation in ${operation}: expected business ${expected}, got ${actual}`
        );
    }
    return true;
}

/**
 * Assert that an array of IDs all belong to the expected business.
 */
function assertAllTenantIds(businessId, ids, fieldName = "ids") {
    const normalized = normalizeBusinessId(businessId);
    for (const id of ids) {
        if (id && typeof id === "string" && id.startsWith("biz_") && !id.startsWith(`biz_${businessId}`)) {
            throw new AppError(
                403,
                "tenant_isolation_violation",
                `${fieldName} contains IDs from different tenant`
            );
        }
    }
    return true;
}

/**
 * Assert that a database query result only contains records for the expected business.
 * Runs in development/test mode only (controlled by NODE_ENV).
 */
function assertQueryResultsTenant(queryResults, businessId, context = "query") {
    if (process.env.NODE_ENV === "production") return queryResults;
    
    const normalized = normalizeBusinessId(businessId);
    const results = Array.isArray(queryResults) ? queryResults : [queryResults];
    
    for (const row of results) {
        if (row && row.business_id) {
            const rowBiz = normalizeBusinessId(row.business_id);
            if (rowBiz !== normalized) {
                throw new AppError(
                    500,
                    "tenant_isolation_violation",
                    `Query result in ${context} contains row from different tenant: expected ${normalized}, got ${rowBiz}`
                );
            }
        }
    }
    return queryResults;
}

/**
 * Middleware to add tenant isolation assertions to responses.
 * Adds a header that can be used for debugging.
 */
function tenantIsolationMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
        // In non-production, add tenant context header for debugging
        if (process.env.NODE_ENV !== "production" && req.xeven?.businessId) {
            res.setHeader("X-Xeven-Tenant", req.xeven.businessId);
        }
        return originalJson(data);
    };
    
    next();
}

/**
 * Validate that a request body doesn't contain tenant IDs from other businesses.
 * Used for write operations where client might try to inject foreign IDs.
 */
function sanitizeRequestBody(body, businessId) {
    if (!body || typeof body !== "object") return body;
    
    const normalized = normalizeBusinessId(businessId);
    const sanitized = { ...body };
    
    // Recursively scan and remove any business_id that doesn't match
    function sanitize(obj, path = "") {
        if (!obj || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(item => sanitize(item, path));
        
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            if (key === "business_id" || key === "businessId") {
                const normalized = normalizeBusinessId(value);
                if (normalized !== normalizeBusinessId(businessId)) {
                    // Strip or override
                    result[path ? `${path}.${key}` : key] = businessId;
                    continue;
                }
            }
            if (value && typeof value === "object") {
                result[key] = sanitize(value, path ? `${path}.${key}` : key);
            } else {
                result[key] = value;
            }
        }
        return result;
    }
    
    return sanitize(sanitized);
}

/** Normalize business ID for comparison. Non-scalar input normalizes to
 * "" (never to a lookalike like "object_object", which could collide
 * across tenants). */
function normalizeBusinessId(id) {
    if (!id) return "";
    if (typeof id !== "string" && typeof id !== "number") return "";
    return String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 80);
}

module.exports = {
    assertTenantContext,
    assertAllTenantIds,
    assertQueryResultsTenant,
    tenantIsolationMiddleware,
    sanitizeRequestBody,
    normalizeBusinessId,
};