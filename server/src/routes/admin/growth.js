"use strict";

/**
 * Founder-only growth-suite endpoints: portal users, capability flags,
 * weekly digest, and manual follow-up processing.
 *
 * Mounted under /api/admin. requireAdmin + loadOwnedBusiness apply; only
 * SUPER admins may change flags or create portal logins (enforced here).
 */

const express = require("express");
const adminAuth = require("../../auth/admin");
const portal = require("../../auth/portal");
const flagsStore = require("../../core/flags/store");
const outcomes = require("../../core/outcomes/store");
const followUps = require("../../core/followups/engine");
const digests = require("../../core/digests/engine");
const mailer = require("../../core/mailer");
const auditStore = require("../../core/audit/store");
const db = require("../../db").get;
const { badRequest } = require("../../lib/errors");

const router = express.Router();

router.use(adminAuth.requireAdmin);

/** Business-scoped routes below use this; platform-wide routes skip it. */
const scoped = [adminAuth.loadOwnedBusiness];

function assertSuper(req) {
    if (!req.xeven.isSuper) {
        const err = new Error("Only the super admin can manage portal access and capabilities.");
        err.status = 403;
        throw err;
    }
}

// --- weekly digest (platform-wide, super admin sees everything) --------------

router.get("/digest", (req, res, next) => {
    try {
        assertSuper(req);
        let from;
        if (req.query.week === "last") {
            const thisWeek = outcomes.weekStart();
            from = thisWeek - 7 * 24 * 60 * 60 * 1000;
        } else if (req.query.from) {
            from = Number(req.query.from);
        }
        res.json(outcomes.digestText({ from }));
    } catch (error) {
        next(error);
    }
});

// --- capability flags -------------------------------------------------------

router.get("/businesses/:businessId/features", scoped, (req, res) => {
    res.json({ businessId: req.xeven.businessId, features: flagsStore.getFlags(req.xeven.businessId), allowedKeys: flagsStore.FLAG_KEYS });
});

/** Super admin ONLY — this is how you decide what a business may self-manage. */
router.put("/businesses/:businessId/features", scoped, (req, res, next) => {
    try {
        assertSuper(req);
        const features = flagsStore.setFlags(req.xeven.businessId, req.body || {});
        auditStore.record({ businessId: req.xeven.businessId, actorType: "admin", actorId: req.xeven.adminUid, action: "admin.features.updated" });
        res.json({ businessId: req.xeven.businessId, features });
    } catch (error) {
        next(error);
    }
});

// --- portal users -----------------------------------------------------------

router.get("/businesses/:businessId/portal-users", scoped, (req, res) => {
    assertSuper(req);
    const rows = db
        .prepare("SELECT portal_uid, email, active, created_at FROM portal_users WHERE business_id = ?")
        .all(req.xeven.businessId);
    res.json({ users: rows.map((r) => ({ ...r, portalUid: r.portal_uid, createdAt: r.created_at })) });
});

/** Create (or reset-password) the business's portal login. Returns plaintext password ONCE. */
router.post("/businesses/:businessId/portal-users", scoped, (req, res, next) => {
    try {
        assertSuper(req);
        const body = req.body || {};
        if (!body.email || !body.password) throw badRequest("email and password are required.");

        const existing = db().prepare("SELECT id FROM portal_users WHERE email = ? COLLATE NOCASE").get(String(body.email).trim().toLowerCase());
        if (existing) {
            // Reset flow: update hash + rebind to THIS business.
            db().prepare(
                "UPDATE portal_users SET password_hash = ?, business_id = ?, active = 1, updated_at = ? WHERE id = ?"
            ).run(require("../../lib/crypto").hashPassword(body.password), req.xeven.businessId, Date.now(), existing.id);
            auditStore.record({ businessId: req.xeven.businessId, actorType: "admin", actorId: req.xeven.adminUid, action: "admin.portal_user.reset" });
            return res.json({ success: true, reset: true });
        }

        const user = portal.registerPortalUser({
            businessId: req.xeven.businessId,
            email: body.email,
            password: body.password,
        });
        auditStore.record({ businessId: req.xeven.businessId, actorType: "admin", actorId: req.xeven.adminUid, action: "admin.portal_user.created" });
        res.status(201).json({ user: portal.publicUser(user) });
    } catch (error) {
        next(error);
    }
});

// --- follow-ups --------------------------------------------------------------

router.get("/businesses/:businessId/follow-up-policy", scoped, (req, res) => {
    res.json({ policy: followUps.getPolicy(req.xeven.businessId), smtp: mailer.canSend(req.xeven.businessId).ok ? "configured" : "not-configured" });
});

/** Manually run due follow-ups for observability/testing. */
router.post("/businesses/:businessId/follow-ups/run", scoped, async (req, res, next) => {
    try {
        assertSuper(req);
        const result = await followUps.processDueJobs({});
        res.json(result);
    } catch (error) {
        next(error);
    }
});

// --- owner weekly digest ------------------------------------------------------

router.get("/businesses/:businessId/digest-config", scoped, (req, res) => {
    res.json(digests.getConfig(req.xeven.businessId));
});

/** Super admin ONLY — flip the weekly_digest capability + set the recipient. */
router.put("/businesses/:businessId/digest-config", scoped, (req, res, next) => {
    try {
        assertSuper(req);
        const body = req.body || {};
        if (body.email !== undefined) digests.setEmail(req.xeven.businessId, body.email);
        if (body.enabled !== undefined) flagsStore.setFlags(req.xeven.businessId, { weekly_digest: Boolean(body.enabled) });
        auditStore.record({ businessId: req.xeven.businessId, actorType: "admin", actorId: req.xeven.adminUid, action: "admin.digest.configured" });
        res.json(digests.getConfig(req.xeven.businessId));
    } catch (error) {
        next(error);
    }
});

/** Force-send now (testing), or ?preview=1 to render without sending. */
router.post("/businesses/:businessId/digest/run", scoped, async (req, res, next) => {
    try {
        assertSuper(req);
        const result = await digests.sendNow(req.xeven.businessId, { preview: req.query.preview === "1" });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
