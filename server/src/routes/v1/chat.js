"use strict";

const express = require("express");
const { authenticateIntegration, requireScope } = require("../../auth/integration");
const { runChat } = require("../../core/chat/service");
const customerStore = require("../../core/customers/store");
const audit = require("../../core/audit/store");
const { badRequest } = require("../../lib/errors");

const router = express.Router();

router.post(
    "/",
    authenticateIntegration,
    requireScope("chat:read"),
    async (req, res, next) => {
        try {
            const body = req.body || {};
            const customerInput = body.customer && typeof body.customer === "object" ? body.customer : {};

            const customerId = customerStore.validateCustomerId(customerInput.id || customerInput.customerId);
            if (!customerId) throw badRequest("A valid customer.id is required.", "invalid_customer_id");

            const messages = Array.isArray(body.messages) ? body.messages : [];
            if (messages.length === 0) throw badRequest("At least one message is required.");
            if (messages.length > 100) throw badRequest("Too many messages (max 100).");

            for (const message of messages) {
                if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
                    throw badRequest("Invalid message format.");
                }
                if (message.content.length > 10_000) throw badRequest("Message content is too large.");
            }

            if (typeof body.conversationId !== "undefined" && body.conversationId !== null && String(body.conversationId).length > 100) {
                throw badRequest("conversationId is too long.");
            }

            const result = await runChat({
                businessId: req.xeven.businessId,
                customerInput: { ...customerInput, id: customerId },
                messages,
                conversationId: body.conversationId ? String(body.conversationId) : null,
                channel: "api",
                requestId: req.requestId,
            });

            audit.record({
                businessId: req.xeven.businessId,
                actorType: "integration",
                action: "chat",
                detail: { customerId, provider: result.provider },
                ip: req.ip,
            });

            res.json({ success: true, ...result });
        } catch (error) {
            next(error);
        }
    }
);

module.exports = router;
