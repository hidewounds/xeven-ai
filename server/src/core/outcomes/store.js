"use strict";

/**
 * Outcome tracking + revenue attribution + weekly digest.
 *
 * An "outcome" is a business result XEVEN contributed to: a tracked purchase,
 * a captured lead, or a booking. Purchases arrive via the behavioral tracker
 * (`purchase` events); attribution links them back to conversations the
 * customer had inside the attribution window, so the founder can see what
 * XEVEN's chats are actually worth.
 */

const db = require("../../db").get;
const crypto = require("../../lib/crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTRIBUTION_WINDOW_DAYS = 7;

function now() {
    return Date.now();
}

/** Start of the ISO week (Monday 00:00) containing `at`. */
function weekStart(at = now()) {
    const d = new Date(at);
    const day = (d.getDay() + 6) % 7; // 0 = Monday
    d.setHours(0, 0, 0, 0);
    return d.getTime() - day * DAY_MS;
}

/**
 * Record an outcome. Purchases normally flow in from the behavioral tracker
 * (event_type 'purchase'); leads/bookings from chat capture flows.
 * Supports idempotency via idempotencyKey to prevent duplicate recordings.
 */
function recordOutcome({ businessId, customerId, conversationId = null, outcomeType, amountCents = null, sourceEventId = null, idempotencyKey }) {
    if (!businessId || !customerId) throw new Error("businessId and customerId are required.");
    if (!["purchase", "lead", "booking"].includes(outcomeType)) {
        throw new Error(`Unknown outcome type "${outcomeType}".`);
    }

    // Idempotency check
    if (idempotencyKey) {
        const existing = db().prepare(
            `SELECT outcome_uid FROM outcome_events WHERE business_id = ? AND customer_id = ? AND outcome_type = ? AND amount_cents = ? AND source_event_id = ? ORDER BY created_at DESC LIMIT 1`
        ).get(businessId, customerId, outcomeType, amountCents, sourceEventId);
        if (existing) {
            return { ...getOutcome(existing.outcome_uid), idempotentReplay: true };
        }
    }

    // Attribution: last conversation with this customer inside the window.
    let linkedConversation = conversationId;
    if (!linkedConversation) {
        const cutoff = now() - ATTRIBUTION_WINDOW_DAYS * DAY_MS;
        const row = db()
            .prepare(
                `SELECT conversation_id FROM conversations
                 WHERE business_id = ? AND customer_id = ? AND created_at >= ?
                 ORDER BY created_at DESC LIMIT 1`
            )
            .get(businessId, customerId, cutoff);
        linkedConversation = row ? row.conversation_id : null;
    }

    const uid = crypto.randomId("ocm");
    db().prepare(
        `INSERT INTO outcome_events
         (outcome_uid, business_id, customer_id, conversation_id, outcome_type, amount_cents, source_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uid, businessId, customerId, linkedConversation, outcomeType, amountCents, sourceEventId, now());

    return { ...getOutcome(uid), idempotentReplay: false };
}

function getOutcome(outcomeUid) {
    return db().prepare("SELECT * FROM outcome_events WHERE outcome_uid = ?").get(outcomeUid) || null;
}

/** Did this customer have ANY assistant interaction recently? (attribution gate) */
function hadRecentInteraction(businessId, customerId, withinDays = ATTRIBUTION_WINDOW_DAYS) {
    const cutoff = now() - withinDays * DAY_MS;
    const conv = db()
        .prepare("SELECT 1 FROM conversations WHERE business_id = ? AND customer_id = ? AND created_at >= ? LIMIT 1")
        .get(businessId, customerId, cutoff);
    if (conv) return true;
    const msg = db()
        .prepare("SELECT 1 FROM conversation_messages WHERE business_id = ? AND customer_id = ? AND created_at >= ? LIMIT 1")
        .get(businessId, customerId, cutoff);
    return Boolean(msg);
}

/**
 * Weekly summary per business (or platform-wide when businessId omitted).
 * Returns rows for each business active in the window: chats, outcomes,
 * attributed revenue, follow-up emails sent.
 */
function weeklySummary({ from, to } = {}) {
    const toTs = to || now();
    const fromTs = from || weekStart(toTs);

    const businesses = db().prepare("SELECT business_id, business_name FROM businesses").all();
    const rows = [];

    for (const biz of businesses) {
        const chats = db()
            .prepare("SELECT COUNT(*) AS n FROM conversations WHERE business_id = ? AND created_at BETWEEN ? AND ?")
            .get(biz.business_id, fromTs, toTs).n;

        const outcomes = db()
            .prepare("SELECT outcome_type, COUNT(*) AS n, SUM(COALESCE(amount_cents, 0)) AS cents FROM outcome_events WHERE business_id = ? AND created_at BETWEEN ? AND ? GROUP BY outcome_type")
            .all(biz.business_id, fromTs, toTs);

        const byType = { purchase: 0, lead: 0, booking: 0 };
        let revenueCents = 0;
        for (const o of outcomes) {
            byType[o.outcome_type] = o.n;
            if (o.outcome_type === "purchase") revenueCents += o.cents || 0;
        }

        const emailsSent = db()
            .prepare("SELECT COUNT(*) AS n FROM email_log WHERE business_id = ? AND status = 'sent' AND created_at BETWEEN ? AND ?")
            .get(biz.business_id, fromTs, toTs).n;

        if (chats || byType.purchase || byType.lead || emailsSent) {
            rows.push({
                businessId: biz.business_id,
                businessName: biz.business_name,
                chats,
                purchases: byType.purchase,
                leads: byType.lead,
                bookings: byType.booking,
                attributedRevenueCents: revenueCents,
                followUpEmailsSent: emailsSent,
            });
        }
    }

    return {
        weekStart: fromTs,
        weekEnd: toTs,
        totalAttributedRevenueCents: rows.reduce((s, r) => s + r.attributedRevenueCents, 0),
        businesses: rows,
    };
}

/** Human-readable Monday digest text (for email / Telegram / dashboard). */
function digestText({ from, to } = {}) {
    const summary = weeklySummary({ from, to });
    const fmt = (cents) => "$" + (cents / 100).toFixed(2);

    const lines = [
        `XEVEN WEEKLY DIGEST — ${new Date(summary.weekStart).toISOString().slice(0, 10)} → ${new Date(summary.weekEnd).toISOString().slice(0, 10)}`,
        `Total attributed revenue: ${fmt(summary.totalAttributedRevenueCents)}`,
        "",
    ];

    if (!summary.businesses.length) {
        lines.push("No activity this week.");
    } else {
        for (const b of summary.businesses) {
            lines.push(
                `${b.businessName}: ${b.chats} chats · ${b.leads} leads · ${b.purchases} purchases (${fmt(b.attributedRevenueCents)}) · ${b.followUpEmailsSent} follow-up emails`
            );
        }
    }
    return { text: lines.join("\n"), summary };
}

module.exports = { recordOutcome, getOutcome, hadRecentInteraction, weeklySummary, digestText, weekStart };
