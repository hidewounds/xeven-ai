"use strict";

/**
 * Follow-up engine — proactive customer outreach on the BUSINESS's behalf.
 *
 * Policy (per business, editable in their portal, gated by founder flags):
 *   first_days     — days to wait after the trigger before the FIRST follow-up
 *   max_attempts   — total follow-up emails before XEVEN drops it
 *   interval_days  — gap between consecutive attempts
 *
 * Every email is sent FROM the business's own address (their SMTP). XEVEN owns
 * no identity of its own — it is staff, not a sender.
 */

const db = require("../../db").get;
const crypto = require("../../lib/crypto");
const mailer = require("../mailer");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CAP = 30; // hard caps so a misconfigured portal can't spam
const INTERVAL_CAP_DAYS = 60;

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Effective policy for a business, clamped and defaulted. */
function getPolicy(businessId) {
    const s = db().prepare("SELECT * FROM portal_settings WHERE business_id = ?").get(businessId) || {};
    return {
        enabled: Boolean(s.follow_up_enabled),
        firstDays: clamp(s.follow_up_first_days, 0, MAX_CAP, 1),
        maxAttempts: clamp(s.follow_up_max_attempts, 1, 10, 3),
        intervalDays: clamp(s.follow_up_interval_days, 1, INTERVAL_CAP_DAYS, 2),
        contactEmail: s.contact_email || "",
    };
}

/**
 * Schedule a follow-up chain. Triggered by abandoned carts / captured leads.
 * Returns the created job (or { skipped, reason }).
 */
function scheduleFollowUp({ businessId, customerId, email, kind = "cart", payload = {} }) {
    if (!businessId || !customerId) throw new Error("businessId and customerId are required.");
    if (!email) return { skipped: true, reason: "no email on file" };

    const policy = getPolicy(businessId);
    if (!policy.enabled) return { skipped: true, reason: "follow-ups disabled" };

    // One live chain per customer per kind.
    const existing = db()
        .prepare("SELECT * FROM follow_up_jobs WHERE business_id = ? AND customer_id = ? AND kind = ? AND status = 'scheduled'")
        .get(businessId, customerId, kind);
    if (existing) return { skipped: true, reason: "already scheduled", job: existing };

    const uid = crypto.randomId("fup");
    const t = Date.now();
    db().prepare(
        `INSERT INTO follow_up_jobs
         (job_uid, business_id, customer_id, email, kind, payload_json, status, attempts, max_attempts, next_send_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?, ?)`
    ).run(
        uid,
        businessId,
        customerId,
        String(email).toLowerCase(),
        kind,
        JSON.stringify(payload || {}),
        policy.maxAttempts,
        t + policy.firstDays * DAY_MS,
        t,
        t
    );

    return { scheduled: true, jobUid: uid, nextSendAt: t + policy.firstDays * DAY_MS };
}

/**
 * Compose the follow-up email for a job. Personalized from the cart/lead
 * payload; signed by the business identity, never by "XEVEN".
 */
function composeEmail(job, settings) {
    let payload = {};
    try {
        payload = JSON.parse(job.payload_json || "{}");
    } catch {}

    const bizName = settings.smtp_from_name || "our team";
    if (job.kind === "lead") {
        return {
            subject: `Following up from ${bizName}`,
            text:
                `Hi${payload.name ? " " + payload.name : ""},\n\n` +
                `Thanks for reaching out to ${bizName}. I wanted to check in — did you have any more questions I can help with?\n\n` +
                `Best regards,\n${bizName}`,
        };
    }

    const items = Array.isArray(payload.items) && payload.items.length
        ? payload.items.map((i) => `- ${i.name || i.sku || "item"}${i.quantity ? ` ×${i.quantity}` : ""}`).join("\n")
        : "- the items in your cart";
    return {
        subject: `${bizName}: your cart is waiting`,
        text:
            `Hi${payload.name ? " " + payload.name : ""},\n\n` +
            `You left some items in your cart:\n${items}\n\n` +
            `Would you like me to help you complete the order or answer any questions?\n\n` +
            `Best regards,\n${bizName}`,
    };
}

/**
 * Process all due follow-ups. Called periodically from the server boot loop
 * and manually via the admin API. Returns what happened for observability.
 */
async function processDueJobs({ limit = 25 } = {}) {
    const nowTs = Date.now();
    const due = db()
        .prepare(
            `SELECT * FROM follow_up_jobs
             WHERE status = 'scheduled' AND next_send_at <= ?
             ORDER BY next_send_at ASC LIMIT ?`
        )
        .all(nowTs, limit);

    const results = [];
    for (const job of due) {
        const policy = getPolicy(job.business_id);
        if (!policy.enabled || !policy.contactEmail) {
            // Config was switched off mid-chain — drop quietly.
            db().prepare("UPDATE follow_up_jobs SET status = 'dropped', updated_at = ? WHERE id = ?").run(nowTs, job.id);
            results.push({ jobUid: job.job_uid, action: "dropped", reason: "disabled" });
            continue;
        }
        if (job.attempts >= job.max_attempts) {
            db().prepare("UPDATE follow_up_jobs SET status = 'dropped', updated_at = ? WHERE id = ?").run(nowTs, job.id);
            results.push({ jobUid: job.job_uid, action: "dropped", reason: "max attempts reached" });
            continue;
        }

        const settings = mailer.getSettings(job.business_id);
        const { subject, text } = composeEmail(job, settings);
        const result = await mailer.sendAsBusiness(job.business_id, { to: job.email, subject, text });

        const attempts = job.attempts + 1;
        const exhausted = attempts >= job.max_attempts;

        if (!result.sent) {
            // Retry later at the same interval; count as an attempt only after
            // repeated failures would be unfair — but keep it simple & honest:
            // failed sends consume an attempt so we can never spam.
            db().prepare(
                `UPDATE follow_up_jobs SET status = ?, attempts = ?, last_sent_at = ?, next_send_at = ?, updated_at = ? WHERE id = ?`
            ).run(exhausted ? "dropped" : "scheduled", attempts, nowTs, nowTs + policy.intervalDays * DAY_MS, nowTs, job.id);
            results.push({ jobUid: job.job_uid, action: exhausted ? "dropped" : "retry-scheduled", error: result.error });
            continue;
        }

        db().prepare(
            `UPDATE follow_up_jobs SET status = ?, attempts = ?, last_sent_at = ?, next_send_at = ?, updated_at = ? WHERE id = ?`
        ).run(exhausted ? "sent" : "scheduled", attempts, nowTs, nowTs + policy.intervalDays * DAY_MS, nowTs, job.id);

        // Mark earlier sent attempts as answered/dropped implicitly via status:
        // 'sent' means the final attempt went out; intermediate stays scheduled.
        results.push({ jobUid: job.job_uid, action: "sent", attempt: attempts, of: job.max_attempts });
    }

    return { processed: results.length, results };
}

/** Customer replied / purchased → stop following up. */
function markAnswered(businessId, customerId, kind = "cart") {
    db().prepare(
        "UPDATE follow_up_jobs SET status = 'answered', updated_at = ? WHERE business_id = ? AND customer_id = ? AND kind = ? AND status = 'scheduled'"
    ).run(Date.now(), businessId, customerId, kind);
}

module.exports = { getPolicy, scheduleFollowUp, processDueJobs, markAnswered, composeEmail };
