"use strict";

const express = require("express");
const { authenticateIntegration, requireSecretKey } = require("../../auth/integration");
const configService = require("../../core/config/service");
const audit = require("../../core/audit/store");
// Unified brain — roles removed (see server/src/core/agent/brain.js)
const { badRequest } = require("../../lib/errors");

const router = express.Router();

router.use(authenticateIntegration);

// ---------------------------------------------------------------------------
// business identity
// ---------------------------------------------------------------------------

router.get("/business", (req, res) => {
    const config = configService.getConfig(req.xeven.businessId);
    res.json({
        business: req.xevenBusiness,
        config: configService.sanitizeConfig(config),
    });
});

router.patch("/business", requireSecretKey, (req, res, next) => {
    try {
        const body = req.body || {};
        if (body.businessName === undefined && body.active === undefined) {
            throw badRequest("Provide businessName and/or active to update.");
        }
        const business = configService.updateBusinessIdentity(req.xeven.businessId, {
            businessName: body.businessName,
            active: typeof body.active === "boolean" ? body.active : undefined,
        });
        audit.record({
            businessId: req.xeven.businessId,
            actorType: "integration",
            action: "business.updated",
            detail: { fields: Object.keys(body) },
            ip: req.ip,
        });
        res.json({ business });
    } catch (error) {
        next(error);
    }
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

router.put("/config", requireSecretKey, (req, res, next) => {
    try {
        const nextConfig = configService.updateConfig(req.xeven.businessId, req.body || {});
        audit.record({
            businessId: req.xeven.businessId,
            actorType: "integration",
            action: "config.updated",
            detail: { sections: Object.keys(req.body || {}) },
            ip: req.ip,
        });
        res.json({ config: configService.sanitizeConfig(nextConfig) });
    } catch (error) {
        next(error);
    }
});

/** Import a previously exported configuration. */
router.post("/config/import", requireSecretKey, (req, res, next) => {
    try {
        const imported = (req.body || {}).config;
        if (!imported || typeof imported !== "object") throw badRequest("Body must contain a config object.");
        const normalized = configService.updateConfig(req.xeven.businessId, imported);
        res.json({ config: configService.sanitizeConfig(normalized) });
    } catch (error) {
        next(error);
    }
});

router.get("/config/export", (req, res) => {
    const config = configService.getConfig(req.xeven.businessId);
    res.json({
        xevenConfigExport: true,
        exportedAt: new Date().toISOString(),
        businessName: req.xeven.businessName,
        config: configService.sanitizeConfig(config),
    });
});

// ---------------------------------------------------------------------------
// integration key management
// ---------------------------------------------------------------------------

router.post("/business/rotate-key", requireSecretKey, (req, res, next) => {
    try {
        const result = configService.rotateIntegrationKey(req.xeven.businessId);
        audit.record({
            businessId: req.xeven.businessId,
            actorType: "integration",
            action: "key.rotated",
            detail: {},
            ip: req.ip,
        });
        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
