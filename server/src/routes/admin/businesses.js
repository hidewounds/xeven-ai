"use strict";

const express = require("express");
const adminAuth = require("../../auth/admin");
const configService = require("../../core/config/service");
const analytics = require("../../core/analytics/service");
const auditStore = require("../../core/audit/store");
const db = require("../../db");
const { badRequest } = require("../../lib/errors");

const router = express.Router();

router.use(adminAuth.requireAdmin);
// Cookie-authed mutations require a CSRF token (Bearer requests skip it).
router.use(adminAuth.requireAdminCsrf);

// --- retention: 15-day purge for deactivated businesses --------------------
router.get("/retention/deactivated", (req, res, next) => {
    try {
        const adminRow = db.get().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId);
        if (!adminRow.is_super) return res.status(403).json({ error: { code: "forbidden", message: "Super admin only." } });
        const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
        let rows;
        try {
            rows = db.get().prepare(`SELECT business_id, business_name, plan, active, updated_at, deactivated_at FROM businesses WHERE active = 0 ORDER BY updated_at ASC`).all();
        } catch {
            rows = db.get().prepare(`SELECT business_id, business_name, plan, active, updated_at FROM businesses WHERE active = 0 ORDER BY updated_at ASC`).all();
        }
        const withDue = rows.map((r) => ({
            businessId: r.business_id,
            businessName: r.business_name,
            plan: r.plan,
            deactivatedAt: r.deactivated_at || r.updated_at,
            daysSinceDeactivation: Math.floor((Date.now() - (r.deactivated_at || r.updated_at)) / (24*60*60*1000)),
            dueInDays: Math.max(0, 15 - Math.floor((Date.now() - (r.deactivated_at || r.updated_at)) / (24*60*60*1000))),
            willPurgeAt: new Date((r.deactivated_at || r.updated_at) + 15*24*60*60*1000).toISOString(),
            isDue: (r.deactivated_at || r.updated_at) <= cutoff,
        }));
        res.json({ deactivated: withDue, retentionDays: 15 });
    } catch (e) { next(e); }
});

router.post("/retention/purge", async (req, res, next) => {
    try {
        const adminRow = db.get().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId);
        if (!adminRow.is_super) return res.status(403).json({ error: { code: "forbidden", message: "Super admin only." } });
        const retention = require("../../core/retention");
        const result = await retention.processDeactivatedBusinesses({ now: Date.now() });
        res.json(result);
    } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// business provisioning
// ---------------------------------------------------------------------------

/** List businesses this admin can access. */
router.get("/businesses", (req, res) => {
    const adminRow = db.get().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId);
    res.json({ businesses: adminAuth.listAccessibleBusinesses(adminRow) });
});

/**
 * Create a new business. This is the onboarding entry point:
 * a brand-new tenant can be provisioned entirely through the API/dashboard
 * without touching source code.
 */
router.post("/businesses", (req, res, next) => {
    try {
        const body = req.body || {};
        if (!body.businessName || typeof body.businessName !== "string" || !body.businessName.trim()) {
            throw badRequest("businessName is required.");
        }

        const created = configService.createBusiness({
            businessId: body.businessId,
            businessName: body.businessName,
            config: body.config,
        });

        const adminRow = db.get().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId);
        if (!adminRow.is_super) {
            adminAuth.grantBusinessAccess(req.xeven.adminId, created.business.businessId);
        }

        auditStore.record({
            businessId: created.business.businessId,
            actorType: "admin",
            actorId: req.xeven.adminUid,
            action: "business.created",
            detail: { businessName: body.businessName },
            ip: req.ip,
        });

        res.status(201).json(created);
    } catch (error) {
        next(error);
    }
});

// everything below is scoped to a business the admin owns
router.use("/businesses/:businessId", adminAuth.loadOwnedBusiness);

router.get("/businesses/:businessId", (req, res) => {
    // Unified brain — no role limits, all plans have full pattern access
    const config = configService.getConfig(req.xeven.businessId, { bypassLimit: true });
    const sanitized = configService.sanitizeConfig(config);
    const { PATTERN_IDS } = require("../../core/agent/brain");
    const maxRoles = null; // unified: no role cap
    const isSuper = Boolean(req.xeven && req.xeven.isSuper);
    // Security posture warnings for the dashboard (default-allow CORS etc.)
    const securityWarnings = [];
    try {
        const env = require("../../env");
        if (env.isProduction && (!env.allowedOrigins || env.allowedOrigins.length === 0)) {
            securityWarnings.push({ code: "cors-open", message: "CORS is open in production (XEVEN_ALLOWED_ORIGINS not set). Set it to your dashboard origins.", tab: "settings" });
        }
        if (env.isProduction && !env.adminTokenSecretFromEnv) {
            securityWarnings.push({ code: "admin-secret-ephemeral", message: "XEVEN_ADMIN_TOKEN_SECRET is not set — admin sessions may not survive restarts.", tab: "settings" });
        }
        const origins = Array.isArray(sanitized.security?.allowedOrigins) ? sanitized.security.allowedOrigins : [];
        if (env.isProduction && origins.length === 0) {
            securityWarnings.push({ code: "widget-origins-open", message: "Widget embeds accept any domain. Set Security → Allowed origins to lock embedding to your sites.", tab: "integration" });
        }
    } catch {}
    res.json({ business: req.xevenBusiness, config: sanitized, plan: req.xevenBusiness.plan, maxRoles, roleKeys: PATTERN_IDS, brainPatterns: PATTERN_IDS, brain: "unified", isSuper, adminBypass: true, securityWarnings });
});

router.patch("/businesses/:businessId", (req, res, next) => {
    try {
        const body = req.body || {};

        // Plan changes are commercial decisions — super-admin only.
        let business = req.xevenBusiness;
        if (body.plan !== undefined) {
            const adminRow = db.get().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId);
            if (!adminRow.is_super) {
                return res.status(403).json({
                    error: { code: "forbidden", message: "Only the super admin can change business plans.", requestId: req.requestId },
                });
            }
            business = configService.setBusinessPlan(req.xeven.businessId, body.plan);
        }

        // Identity update.
        if (body.businessName !== undefined || body.active !== undefined) {
            business = configService.updateBusinessIdentity(req.xeven.businessId, {
                businessName: body.businessName,
                active: typeof body.active === "boolean" ? body.active : undefined,
            });
        }

        // Configuration update — ALL admins bypass plan caps (admin override), portals are capped
        let config;
        if (body.config && typeof body.config === "object") {
            config = configService.updateConfig(req.xeven.businessId, body.config, { bypassLimit: true });
        } else {
            config = configService.getConfig(req.xeven.businessId, { bypassLimit: true });
        }

        auditStore.record({
            businessId: req.xeven.businessId,
            actorType: "admin",
            actorId: req.xeven.adminUid,
            action: "business.updated",
            detail: { fields: Object.keys(body), plan: body.plan },
            ip: req.ip,
        });

        res.json({ business, config: configService.sanitizeConfig(config) });
    } catch (error) {
        next(error);
    }
});

/** Rotate the integration key. */
router.post("/businesses/:businessId/rotate-key", (req, res, next) => {
    try {
        const result = configService.rotateIntegrationKey(req.xeven.businessId);
        auditStore.record({
            businessId: req.xeven.businessId,
            actorType: "admin",
            actorId: req.xeven.adminUid,
            action: "key.rotated",
            ip: req.ip,
        });
        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
});

/** Analytics for the dashboard. */
router.get("/businesses/:businessId/analytics", (req, res) => {
    res.json(analytics.summary(req.xeven.businessId));
});

/** Audit trail for the dashboard. */
router.get("/businesses/:businessId/audit", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ entries: auditStore.listAudit(req.xeven.businessId, { limit }) });
});

// ---------------------------------------------------------------------------
// knowledge management (admin-scoped; no integration key required)
// ---------------------------------------------------------------------------

const knowledgeStore = require("../../core/knowledge/store");
const customersStore = require("../../core/customers/store");
const memoryStore = require("../../core/memory/store");
const behaviorStore = require("../../core/behavior/store");

router.get("/businesses/:businessId/knowledge", (req, res) => {
    res.json(knowledgeStore.listKnowledge(req.xeven.businessId));
});

router.post("/businesses/:businessId/knowledge", (req, res, next) => {
    try {
        const body = req.body || {};
        const item = knowledgeStore.createKnowledgeItem({
            businessId: req.xeven.businessId,
            title: body.title,
            knowledgeType: body.knowledgeType,
            content: body.content,
        });
        auditStore.record({
            businessId: req.xeven.businessId,
            actorType: "admin",
            actorId: req.xeven.adminUid,
            action: "knowledge.created",
            detail: { knowledgeId: item.knowledge_id },
            ip: req.ip,
        });
        res.status(201).json({ item });
    } catch (error) {
        next(error);
    }
});

router.patch("/businesses/:businessId/knowledge/:knowledgeId", (req, res, next) => {
    try {
        const item = knowledgeStore.updateKnowledgeItem(req.xeven.businessId, req.params.knowledgeId, req.body || {});
        res.json({ item });
    } catch (error) {
        next(error);
    }
});

router.delete("/businesses/:businessId/knowledge/:knowledgeId", (req, res, next) => {
    try {
        const deleted = knowledgeStore.deleteKnowledgeItem(req.xeven.businessId, req.params.knowledgeId);
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

// ---------------------------------------------------------------------------
// customer management (admin-scoped)
// ---------------------------------------------------------------------------

router.get("/businesses/:businessId/customers", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(customersStore.listCustomers(req.xeven.businessId, { limit, offset }));
});

router.get("/businesses/:businessId/customers/:customerId/memories", (req, res) => {
    res.json({ memories: memoryStore.listMemories(req.xeven.businessId, req.params.customerId) });
});

router.delete("/businesses/:businessId/customers/:customerId/memories", (req, res, next) => {
    try {
        const deleted = memoryStore.deleteAllMemories(req.xeven.businessId, req.params.customerId);
        auditStore.record({
            businessId: req.xeven.businessId,
            actorType: "admin",
            actorId: req.xeven.adminUid,
            action: "memory.all_deleted",
            detail: { customerId: req.params.customerId },
            ip: req.ip,
        });
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

router.get("/businesses/:businessId/customers/:customerId/behavior", (req, res) => {
    res.json({ events: behaviorStore.listRecentBehavior(req.xeven.businessId, req.params.customerId, 100) });
});

router.delete("/businesses/:businessId/customers/:customerId", (req, res, next) => {
    try {
        const deleted = customersStore.deleteCustomer(req.xeven.businessId, req.params.customerId);
        auditStore.record({
            businessId: req.xeven.businessId,
            actorType: "admin",
            actorId: req.xeven.adminUid,
            action: "customer.deleted",
            detail: { customerId: req.params.customerId },
            ip: req.ip,
        });
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

// ---------------------------------------------------------------------------
// growth suite (portal users, feature flags, digest, follow-ups)
// ---------------------------------------------------------------------------

router.use(require("./growth"));

module.exports = router;
