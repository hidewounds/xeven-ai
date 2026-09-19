"use strict";

const express = require("express");
const { authenticateIntegration, requireScope, requireSecretKey } = require("../../auth/integration");
const behaviorStore = require("../../core/behavior/store");
const customers = require("../../core/customers/store");
const outcomes = require("../../core/outcomes/store");
const followUps = require("../../core/followups/engine");
const { getConfig } = require("../../core/config/service");
const { badRequest } = require("../../lib/errors");

const router = express.Router();

router.use(authenticateIntegration);

/** Ingest a behavioral event. */
router.post("/behavior", requireScope("behavior:write"), (req, res, next) => {
    try {
        const body = req.body || {};
        const customerId = customers.validateCustomerId(body.customerId || body.customer?.id);
        if (!customerId) throw badRequest("A valid customerId is required.");

        const eventType = String(body.eventType || "");
        const result = behaviorStore.saveBehaviorEvent({
            businessId: req.xeven.businessId,
            customerId,
            eventType,
            eventData: body.eventData || {},
            config: getConfig(req.xeven.businessId),
        });

        // --- growth suite hooks -------------------------------------------------
        const extras = {};

        // Purchases become attributed revenue outcomes.
        if (eventType === "purchase" && result.saved) {
            try {
                const amountCents = Number(body.eventData?.amount_cents ?? body.eventData?.total_cents) || null;
                extras.outcome = outcomes.recordOutcome({
                    businessId: req.xeven.businessId,
                    customerId,
                    outcomeType: "purchase",
                    amountCents,
                    sourceEventId: result.event_id || null,
                }).outcome_uid;
                // A purchase ends any pending follow-up chain.
                followUps.markAnswered(req.xeven.businessId, customerId, "cart");
            } catch {
                // attribution must never break ingestion
            }
        }

        // Abandoned carts schedule the follow-up chain (per-business policy).
        if (eventType === "cart" && result.saved) {
            try {
                const customer = customers.getCustomer(req.xeven.businessId, customerId);
                if (customer && customer.email) {
                    extras.followUp = followUps.scheduleFollowUp({
                        businessId: req.xeven.businessId,
                        customerId,
                        email: customer.email,
                        kind: "cart",
                        payload: { items: body.eventData?.items || [], name: customer.name || "" },
                    });
                }
            } catch {
                // scheduling must never break ingestion
            }
        }

        res.status(result.saved ? 201 : 200).json({ success: true, ...result, ...extras });
    } catch (error) {
        next(error);
    }
});

router.get("/behavior", requireScope("behavior:read"), requireSecretKey, (req, res, next) => {
    try {
        const customerId = customers.validateCustomerId(req.query.customerId);
        if (!customerId) throw badRequest("A valid customerId query parameter is required.");
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const result = behaviorStore.listRecentBehavior(req.xeven.businessId, customerId, limit);
        // Return flat shape {events:[], total, limit, offset} so data.events is array (tests expect array)
        res.json(result);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
