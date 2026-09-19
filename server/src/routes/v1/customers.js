"use strict";

const express = require("express");
const { authenticateIntegration, requireSecretKey } = require("../../auth/integration");
const customers = require("../../core/customers/store");
const memoryStore = require("../../core/memory/store");
const behaviorStore = require("../../core/behavior/store");
const conversationStore = require("../../core/conversations/store");
const audit = require("../../core/audit/store");
const { badRequest, notFound } = require("../../lib/errors");

const router = express.Router();

router.use(authenticateIntegration);
// NOTE: no router-level requireSecretKey — this router is mounted at /api/v1
// (see app.js), so router-level middleware would gate unrelated paths.
// The guard is per-route below. PATCH /customers/:customerId stays open:
// the widget's email-capture flow uses it with the publishable key.

function requireCustomerParam(req) {
    const customerId = customers.validateCustomerId(req.params.customerId);
    if (!customerId) throw badRequest("Invalid customer id.");
    return customerId;
}

// ---------------------------------------------------------------------------
// customer profile
// ---------------------------------------------------------------------------

router.get("/customers", requireSecretKey, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(customers.listCustomers(req.xeven.businessId, { limit, offset }));
});

router.get("/customers/:customerId", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const customer = customers.getCustomer(req.xeven.businessId, customerId);
        if (!customer) throw notFound("Customer not found.");
        res.json({ customer });
    } catch (error) {
        next(error);
    }
});

/** Update profile basics — used by the widget's email-capture flow. */
router.patch("/customers/:customerId", (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const body = req.body || {};
        const existing = customers.getCustomer(req.xeven.businessId, customerId);
        const updated = customers.upsertCustomer({
            businessId: req.xeven.businessId,
            customerId,
            name: body.name !== undefined ? body.name : existing?.name,
            email: body.email !== undefined ? body.email : existing?.email,
            phone: body.phone !== undefined ? body.phone : existing?.phone,
        });
        audit.record({ businessId: req.xeven.businessId, actorType: "integration", action: "customer.profile_updated", detail: { customerId } });
        res.json({ customer: updated });
    } catch (error) {
        next(error);
    }
});

router.delete("/customers/:customerId", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const deleted = customers.deleteCustomer(req.xeven.businessId, customerId);
        audit.record({
            businessId: req.xeven.businessId,
            actorType: "integration",
            action: "customer.deleted",
            detail: { customerId },
            ip: req.ip,
        });
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

// ---------------------------------------------------------------------------
// memories
// ---------------------------------------------------------------------------

router.get("/customers/:customerId/memories", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const limit = Math.min(Number(req.query.limit) || 500, 1000);
        res.json({ memories: memoryStore.listMemories(req.xeven.businessId, customerId, limit) });
    } catch (error) {
        next(error);
    }
});

router.delete("/customers/:customerId/memories/:key", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const key = String(req.params.key || "").trim().toLowerCase();
        const deleted = memoryStore.deleteMemory(req.xeven.businessId, customerId, key);
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

router.delete("/customers/:customerId/memories", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const deleted = memoryStore.deleteAllMemories(req.xeven.businessId, customerId);
        audit.record({
            businessId: req.xeven.businessId,
            actorType: "integration",
            action: "memory.all_deleted",
            detail: { customerId },
            ip: req.ip,
        });
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

// ---------------------------------------------------------------------------
// behavior
// ---------------------------------------------------------------------------

router.get("/customers/:customerId/behavior", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        res.json(behaviorStore.listRecentBehavior(req.xeven.businessId, customerId, limit, offset));
    } catch (error) {
        next(error);
    }
});

router.delete("/customers/:customerId/behavior/:eventId", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const deleted = behaviorStore.deleteBehaviorEvent(req.xeven.businessId, customerId, req.params.eventId);
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

router.delete("/customers/:customerId/behavior", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        const deleted = behaviorStore.deleteAllBehavior(req.xeven.businessId, customerId);
        res.json({ deleted });
    } catch (error) {
        next(error);
    }
});

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

router.get("/customers/:customerId/conversations", requireSecretKey, (req, res, next) => {
    try {
        const customerId = requireCustomerParam(req);
        res.json(conversationStore.listConversations(req.xeven.businessId, { customerId }));
    } catch (error) {
        next(error);
    }
});

module.exports = router;
