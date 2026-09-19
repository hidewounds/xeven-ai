"use strict";

/**
 * Owner weekly digest — every week from Monday DIGEST_HOUR (local server
 * time), businesses with the founder-enabled `weekly_digest` capability get
 * ONE email recapping THEIR week: chats, leads, attributed purchases and the
 * follow-up emails XEVEN sent on their behalf.
 *
 * Rules inherited from the rest of the growth suite:
 *   - capability is founder-controlled (flags: weekly_digest, default OFF)
 *   - mail leaves through the BUSINESS's own SMTP identity, never XEVEN's
 *   - one send per calendar week, deduped in portal_settings.digest_last_sent_week
 *   - if the machine was down Monday morning it catches up on the first tick
 */

const db = require("../../db").get;
const flagsStore = require("../flags/store");
const mailer = require("../mailer");
const outcomes = require("../outcomes/store");

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function digestHour() {
    return Number(process.env.DIGEST_HOUR) || 9;
}

function pad(n) {
    return String(n).padStart(2, "0");
}

/** YYYY-MM-DD (server-local) of the Monday starting the week containing ts. */
function weekKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function badRequest(message) {
    return Object.assign(new Error(message), { status: 400 });
}

/** Effective digest configuration for a business. */
function getConfig(businessId) {
    mailer.ensureSettings(businessId); // row must exist before any UPDATE
    const s = db().prepare("SELECT * FROM portal_settings WHERE business_id = ?").get(businessId) || {};
    const flags = flagsStore.getFlags(businessId);
    const smtp = mailer.canSend(businessId);
    return {
        enabled: Boolean(flags.weekly_digest),
        email: s.digest_email || "",
        lastSentWeek: s.digest_last_sent_week || "",
        smtpConfigured: smtp.ok,
        smtpReason: smtp.reason,
    };
}

/** Owner sets/changes their recipient address ("" clears). Founder flag gates access. */
function setEmail(businessId, email) {
    mailer.ensureSettings(businessId);
    const clean = String(email === undefined || email === null ? "" : email).trim().toLowerCase();
    if (clean && !EMAIL_RE.test(clean)) throw badRequest("That doesn't look like a valid email address.");
    db().prepare("UPDATE portal_settings SET digest_email = ?, updated_at = ? WHERE business_id = ?").run(clean, Date.now(), businessId);
    return getConfig(businessId);
}

/** The completed week before the week containing `nowTs`. */
function previousWeek(nowTs = Date.now()) {
    const ws = outcomes.weekStart(nowTs);
    return { from: ws - 7 * DAY_MS, to: ws - 1 };
}

/**
 * Render THIS business's recap for the window. Never includes other tenants.
 * Returns { subject, text }.
 */
function renderDigest(businessId, { from, to } = {}) {
    const biz = db().prepare("SELECT business_name FROM businesses WHERE business_id = ?").get(businessId);
    if (!biz) throw new Error(`Unknown business "${businessId}".`);

    const summary = outcomes.weeklySummary({ from, to });
    const mine = summary.businesses.find((b) => b.businessId === businessId) || {};
    const fmt = (cents) => "$" + ((cents || 0) / 100).toFixed(2);
    const d = (ts) => new Date(ts).toISOString().slice(0, 10);

    const subject = `${biz.business_name} — your weekly report`;
    const text = [
        "Hi,",
        "",
        `Here is how the week of ${d(from)} → ${d(to)} went:`,
        "",
        `Conversations started: ${mine.chats || 0}`,
        `Leads captured: ${mine.leads || 0}`,
        `Tracked purchases: ${mine.purchases || 0} (${fmt(mine.attributedRevenueCents)})`,
        `Follow-up emails sent for you: ${mine.followUpEmailsSent || 0}`,
        "",
        `— your assistant, on behalf of ${biz.business_name}`,
    ].join("\n");

    return { subject, text };
}

function markSent(businessId, key) {
    mailer.ensureSettings(businessId);
    db()
        .prepare("UPDATE portal_settings SET digest_last_sent_week = ?, updated_at = ? WHERE business_id = ?")
        .run(key, Date.now(), businessId);
}

/**
 * Scheduler pass over ALL businesses. Skips quietly when off / unconfigured /
 * not due; sends and marks one per week otherwise. Returns observability data.
 */
async function processDueDigests({ nowTs = Date.now() } = {}) {
    const ws = outcomes.weekStart(nowTs);
    const dueAt = ws + digestHour() * 60 * 60 * 1000;
    if (nowTs < dueAt) return { checked: 0, sent: 0, reason: "not-due", results: [] };

    const key = weekKeyOf(ws);
    const businesses = db().prepare("SELECT business_id FROM businesses").all();
    const results = [];
    let sent = 0;

    for (const b of businesses) {
        const cfg = getConfig(b.business_id);
        if (!cfg.enabled) {
            results.push({ businessId: b.business_id, action: "skip", reason: "flag-off" });
            continue;
        }
        if (!cfg.email) {
            results.push({ businessId: b.business_id, action: "skip", reason: "no-recipient" });
            continue;
        }
        if (!cfg.smtpConfigured) {
            results.push({ businessId: b.business_id, action: "skip", reason: "smtp-not-configured" });
            continue;
        }
        if (cfg.lastSentWeek === key) {
            results.push({ businessId: b.business_id, action: "skip", reason: "already-sent" });
            continue;
        }

        const { subject, text } = renderDigest(b.business_id, previousWeek(nowTs));
        const r = await mailer.sendAsBusiness(b.business_id, { to: cfg.email, subject, text });
        if (r.sent) {
            markSent(b.business_id, key);
            sent += 1;
            results.push({ businessId: b.business_id, action: "sent" });
        } else {
            results.push({ businessId: b.business_id, action: "failed", error: r.error });
        }
    }

    return { checked: results.length, sent, results };
}

/**
 * Manual trigger (admin API). Force bypasses the schedule window and dedupe,
 * but capability + recipient still apply. preview=true renders without sending.
 */
async function sendNow(businessId, { preview = false } = {}) {
    const cfg = getConfig(businessId);
    if (!cfg.enabled) throw badRequest("The weekly_digest capability is OFF for this business.");
    if (!cfg.email) throw badRequest("No digest recipient set. Configure one first.");

    const rendered = renderDigest(businessId, previousWeek());
    if (preview) return { preview: true, ...rendered };

    const r = await mailer.sendAsBusiness(businessId, { to: cfg.email, subject: rendered.subject, text: rendered.text });
    if (r.sent) markSent(businessId, weekKeyOf(outcomes.weekStart()));
    return { ...r, subject: rendered.subject };
}

module.exports = { getConfig, setEmail, renderDigest, processDueDigests, sendNow, previousWeek, weekKeyOf };
