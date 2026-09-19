"use strict";

/**
 * Weekly digest cron job.
 * Runs every Monday 09:00 UTC to send digests to portal users.
 */

const cron = require("node-cron");
const db = require("../../db").get;
const { weeklySummary, digestText } = require("../outcomes/store");
const digests = require("../digests/engine");
const mailer = require("../mailer");

let cronJob = null;

/**
 * Start the weekly digest cron.
 * Runs every Monday at 09:00 UTC.
 */
function startDigestCron() {
    if (cronJob) {
        console.log("[DIGEST] Cron already running");
        return;
    }

    // Every Monday at 09:00 UTC
    cronJob = cron.schedule("0 9 * * 1", async () => {
        console.log("[DIGEST] Starting weekly digest run");
        try {
            await sendWeeklyDigests();
        } catch (e) {
            console.error("[DIGEST] Weekly digest failed:", e);
        }
    }, {
        timezone: "UTC",
    });

    console.log("[DIGEST] Weekly digest cron started (Mondays 09:00 UTC)");
}

/**
 * Stop the weekly digest cron.
 */
function stopDigestCron() {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
        console.log("[DIGEST] Weekly digest cron stopped");
    }
}

/**
 * Send weekly digests to all businesses with digest configured.
 */
async function sendWeeklyDigests() {
    const now = Date.now();
    const weekStart = now - 7 * 86_400_000; // Last 7 days

    // Get all businesses with digest email configured
    const businesses = db().prepare(`
        SELECT b.business_id, b.business_name, ps.digest_email
        FROM businesses b
        JOIN portal_settings ps ON ps.business_id = b.business_id
        WHERE b.active = 1 AND ps.digest_email IS NOT NULL AND ps.digest_email != ''
    `).all();

    console.log(`[DIGEST] Sending digests to ${businesses.length} businesses`);

    for (const biz of businesses) {
        try {
            // Check if already sent for this week
            const existing = db().prepare(
                `SELECT 1 FROM digest_schedule WHERE business_id = ? AND week_start = ? AND status = 'sent'`
            ).get(biz.business_id, weekStart);
            if (existing) {
                console.log(`[DIGEST] Already sent for ${biz.business_id} this week`);
                continue;
            }

            // Generate digest
            const summary = weeklySummary({ from: weekStart, to: Date.now() });
            const businessSummary = summary.businesses.find(b => b.businessId === biz.business_id);
            if (!businessSummary) {
                console.log(`[DIGEST] No activity for ${biz.business_id}, skipping`);
                continue;
            }

            const { text } = digestText({ from: weekStart, to: Date.now() });
            
            // Send email
            const result = await mailer.sendAsBusiness(biz.business_id, {
                to: biz.digest_email,
                subject: `XEVEN Weekly Digest — ${new Date(weekStart).toISOString().slice(0, 10)}`,
                text,
            });

            // Record in schedule
            db().prepare(
                `INSERT INTO digest_schedule (business_id, week_start, status, recipient_email, digest_text, sent_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(business_id, week_start) DO UPDATE SET
                    status = excluded.status,
                    digest_text = excluded.digest_text,
                    sent_at = excluded.sent_at,
                    error = excluded.error`
            ).run(biz.business_id, weekStart, result.sent ? "sent" : "failed", biz.digest_email, text, result.sent ? Date.now() : null, Date.now());

            if (result.sent) {
                console.log(`[DIGEST] Sent to ${biz.digest_email} for ${biz.business_name}`);
            } else {
                console.error(`[DIGEST] Failed for ${biz.business_name}:`, result.error);
            }
        } catch (e) {
            console.error(`[DIGEST] Error for ${biz.business_id}:`, e);
            
            // Record failure
            try {
                db().prepare(
                    `INSERT INTO digest_schedule (business_id, week_start, status, recipient_email, error, created_at)
                     VALUES (?, ?, 'failed', ?, ?, ?)
                     ON CONFLICT(business_id, week_start) DO UPDATE SET
                        status = 'failed',
                        error = excluded.error`
                ).run(biz.business_id, weekStart, biz.digest_email, e.message, Date.now());
            } catch {}
        }
    }
}

/**
 * Manually trigger digest for a specific business (for testing).
 */
async function triggerDigest(businessId) {
    const weekStart = Date.now() - 7 * 86_400_000;
    const biz = db().prepare("SELECT business_id, business_name FROM businesses WHERE business_id = ?").get(businessId);
    if (!biz) throw new Error("Business not found");

    const settings = db().prepare("SELECT digest_email FROM portal_settings WHERE business_id = ?").get(businessId);
    if (!settings?.digest_email) throw new Error("No digest email configured");

    const summary = weeklySummary({ from: weekStart, to: Date.now() });
    const businessSummary = summary.businesses.find(b => b.businessId === businessId);
    if (!businessSummary) throw new Error("No activity this week");

    const { text } = digestText({ from: weekStart, to: Date.now() });
    const result = await mailer.sendAsBusiness(businessId, {
        to: settings.digest_email,
        subject: `XEVEN Weekly Digest — ${new Date(weekStart).toISOString().slice(0, 10)}`,
        text,
    });

    db().prepare(
        `INSERT INTO digest_schedule (business_id, week_start, status, recipient_email, digest_text, sent_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(business_id, week_start) DO UPDATE SET
            status = excluded.status,
            digest_text = excluded.digest_text,
            sent_at = excluded.sent_at,
            error = excluded.error`
    ).run(businessId, weekStart, result.sent ? "sent" : "failed", settings.digest_email, text, result.sent ? Date.now() : null, Date.now());

    return result;
}

/**
 * Get digest history for a business.
 */
function getDigestHistory(businessId, limit = 10) {
    return db().prepare(
        `SELECT week_start, status, recipient_email, sent_at, error FROM digest_schedule WHERE business_id = ? ORDER BY week_start DESC LIMIT ?`
    ).all(businessId, limit);
}

module.exports = {
    startDigestCron,
    stopDigestCron,
    sendWeeklyDigests,
    triggerDigest,
    getDigestHistory,
};