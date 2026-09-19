"use strict";

/**
 * Webhook security utilities.
 * Sign outbound webhook payloads with HMAC-SHA256.
 * Verify inbound webhook signatures.
 */

const crypto = require("crypto");
const env = require("../env");

const WEBHOOK_SECRET = env.webhookSecret;

/**
 * Sign a webhook payload.
 * @param {Object} payload - The payload to sign
 * @returns {string} - Base64url encoded signature
 */
function signWebhook(payload) {
    if (!WEBHOOK_SECRET) {
        throw new Error("XEVEN_WEBHOOK_SECRET not configured");
    }
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    return crypto.createHmac("sha256", WEBHOOK_SECRET).update(payloadStr).digest("base64url");
}

/**
 * Verify a webhook signature.
 * @param {Object|string} payload - The payload that was signed
 * @param {string} signature - The signature to verify
 * @returns {boolean} - True if valid
 */
function verifyWebhook(payload, signature) {
    if (!WEBHOOK_SECRET) return false;
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payloadStr).digest("base64url");
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Middleware to verify inbound webhook signatures.
 * Expects signature in 'X-Xeven-Signature' header.
 */
function webhookVerifyMiddleware(req, res, next) {
    if (!WEBHOOK_SECRET) {
        return next(); // Skip verification if not configured
    }

    const signature = req.headers["x-xeven-signature"];
    if (!signature) {
        return res.status(401).json({
            error: { code: "webhook_signature_missing", message: "Missing X-Xeven-Signature header." },
            requestId: req.requestId,
        });
    }

    // Use raw body for verification
    const payload = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhook(payload, signature)) {
        return res.status(401).json({
            error: { code: "webhook_signature_invalid", message: "Invalid webhook signature." },
            requestId: req.requestId,
        });
    }

    next();
}

/**
 * Deliver a webhook with retry logic and dead-letter queue.
 * @param {Object} options
 * @param {string} options.url - Target URL
 * @param {Object} options.payload - Payload to send
 * @param {number} [options.maxAttempts=5] - Max retry attempts
 * @param {number} [options.initialDelayMs=1000] - Initial delay in ms
 * @param {number} [options.maxDelayMs=30000] - Max delay in ms
 * @param {string} [options.businessId] - Business ID for logging
 * @param {string} [options.eventType] - Event type for dead-letter queue
 */
async function deliverWebhook({ url, payload, maxAttempts = 5, initialDelayMs = 1000, maxDelayMs = 30000, businessId, eventType, idempotencyKey }) {
    const db = require("../db").get();
    const crypto = require("../lib/crypto");

    const payloadStr = JSON.stringify(payload);
    const signature = signWebhook(payloadStr);
    
    // Idempotency check
    if (idempotencyKey && businessId) {
        const existing = db().prepare(
            `SELECT status_code, attempts, delivered_at FROM webhook_deliveries 
             WHERE business_id = ? AND event_type = ? AND url = ? AND payload_json = ? AND status_code IS NOT NULL
             ORDER BY delivered_at DESC LIMIT 1`
        ).get(businessId, eventType || "unknown", url, payloadStr);
        if (existing) {
            return { success: true, statusCode: existing.status_code, attempts: existing.attempts, idempotentReplay: true };
        }
    }

    const attempt = async (attemptNum, delayMs) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Xeven-Signature": signature,
                    "X-Xeven-Event-Type": eventType || "unknown",
                    "X-Xeven-Delivery-Attempt": String(attemptNum),
                    "User-Agent": "XEVEN-Webhook/1.0",
                },
                body: payloadStr,
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) {
                // Log successful delivery
                if (businessId) {
                    db().prepare(
                        `INSERT INTO webhook_deliveries (delivery_id, business_id, event_type, url, payload_json, status_code, attempts, delivered_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(crypto.randomId("whd"), businessId, eventType || "unknown", url, payloadStr, response.status, attemptNum, Date.now());
                }
                return { success: true, statusCode: response.status };
            }

            throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => "")}`);
        } catch (error) {
            clearTimeout(timeout);
            if (attemptNum >= maxAttempts) {
                // Log to dead-letter queue
                if (businessId) {
                    db().prepare(
                        `INSERT INTO webhook_deliveries (delivery_id, business_id, event_type, url, payload_json, status_code, attempts, error, delivered_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(crypto.randomId("whd"), businessId, eventType || "unknown", url, payloadStr, 0, attemptNum, error.message, Date.now());
                }
                return { success: false, error: error.message, deadLettered: true };
            }

            // Exponential backoff with jitter
            const jitter = Math.random() * 0.3 * delayMs;
            const nextDelay = Math.min(delayMs * 2 + jitter, maxDelayMs);
            await new Promise(r => setTimeout(r, delayMs));
            return attempt(attemptNum + 1, nextDelay);
        }
    };

    return attempt(1, initialDelayMs);
}

module.exports = {
    signWebhook,
    verifyWebhook,
    webhookVerifyMiddleware,
    deliverWebhook,
};