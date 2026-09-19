"use strict";

const fs = require("fs");
const path = require("path");
const db = require("../db").get;
const { logger } = require("../lib/logger");

const RETENTION_DAYS = 15;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Gather all data for a business for export before deletion.
 */
function gatherBusinessData(businessId) {
    const business = db().prepare("SELECT * FROM businesses WHERE business_id = ?").get(businessId);
    if (!business) return null;

    const config = db().prepare("SELECT * FROM business_configs WHERE business_id = ?").get(businessId);
    const knowledge = db().prepare("SELECT * FROM business_knowledge WHERE business_id = ?").all(businessId);
    const customers = db().prepare("SELECT * FROM customers WHERE business_id = ?").all(businessId);
    const memories = db().prepare("SELECT * FROM memories WHERE business_id = ?").all(businessId);
    const behavior = db().prepare("SELECT * FROM behavioral_events WHERE business_id = ?").all(businessId);
    const conversations = db().prepare("SELECT * FROM conversations WHERE business_id = ?").all(businessId);
    const messages = db().prepare("SELECT * FROM conversation_messages WHERE business_id = ? ORDER BY created_at ASC").all(businessId);
    const bookings = (() => {
        try { return db().prepare("SELECT * FROM bookings WHERE business_id = ?").all(businessId); } catch { return []; }
    })();
    const portalSettings = (() => {
        try { return db().prepare("SELECT * FROM portal_settings WHERE business_id = ?").get(businessId) || null; } catch { return null; }
    })();
    const portalUsers = (() => {
        try { return db().prepare("SELECT portal_uid, email, active, created_at FROM portal_users WHERE business_id = ?").all(businessId); } catch { return []; }
    })();
    const addons = (() => {
        try { return db().prepare("SELECT * FROM business_addons WHERE business_id = ?").all(businessId); } catch { return []; }
    })();
    const audit = db().prepare("SELECT * FROM audit_log WHERE business_id = ? ORDER BY created_at DESC LIMIT 500").all(businessId);

    return {
        exportedAt: new Date().toISOString(),
        business,
        config: config ? JSON.parse(config.config_json || "{}") : null,
        knowledge,
        customers,
        memories,
        behavioral_events: behavior,
        conversations,
        conversation_messages: messages,
        bookings,
        portal_settings: portalSettings,
        portal_users: portalUsers,
        addons,
        audit_log: audit,
    };
}

/**
 * Try to mail the export to super admins.
 * Uses the business's own SMTP if configured, otherwise falls back to any
 * configured business SMTP or just logs to disk.
 */
async function mailExportToAdmins(business, exportData) {
    const superAdmins = db().prepare("SELECT email, name FROM admin_users WHERE is_super = 1 AND active = 1").all();
    let recipients = superAdmins.map((r) => r.email).filter(Boolean);

    // Also include admins who had explicit access to this business
    try {
        const extra = db().prepare(`
            SELECT au.email FROM admin_users au
            JOIN admin_business_access aba ON aba.admin_id = au.id
            WHERE aba.business_id = ? AND au.active = 1
        `).all(business.business_id);
        for (const r of extra) if (r.email && !recipients.includes(r.email)) recipients.push(r.email);
    } catch {}

    if (!recipients.length) {
        logger.warn("retention: no admin recipients found", { businessId: business.business_id });
        return { sent: false, reason: "no_recipients" };
    }

    const json = JSON.stringify(exportData, null, 2);
    const subject = `XEVEN — Business "${business.business_name}" (${business.business_id}) deactivated 15d ago — data export`;
    const text = [
        `Hi,`,
        ``,
        `The business "${business.business_name}" (ID: ${business.business_id}, plan: ${business.plan}) was deactivated on ${new Date(business.updated_at).toISOString().slice(0,10)} and has now been held for ${RETENTION_DAYS} days.`,
        ``,
        `As requested, it is being removed from the dashboard. A full JSON export of its data is attached (and also saved to logs/retention/).`,
        ``,
        `Summary:`,
        `- Knowledge items: ${exportData.knowledge.length}`,
        `- Customers: ${exportData.customers.length}`,
        `- Conversations: ${exportData.conversations.length}`,
        `- Messages: ${exportData.conversation_messages.length}`,
        `- Bookings: ${exportData.bookings.length}`,
        ``,
        `If you need to restore, re-create the business with the same business_id and re-import.`,
        ``,
        `— XEVEN retention`,
    ].join("\n");

    // Save to disk for audit (project root logs/retention)
    try {
        const dir = path.join(__dirname, "..", "..", "..", "logs", "retention");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${business.business_id}-${Date.now()}.json`);
        fs.writeFileSync(file, json, "utf8");
        logger.info("retention: export saved to disk", { businessId: business.business_id, file });
    } catch (e) {
        logger.warn("retention: failed to save export to disk", { businessId: business.business_id, error: e.message });
    }

    // Try to send via the business's own SMTP first
    const mailer = require("./mailer");
    let lastError = null;
    for (const to of recipients) {
        // Attempt via business's own mailer; it will use portal_settings SMTP
        const result = await mailer.sendAsBusiness(business.business_id, {
            to,
            subject,
            text: text + "\n\n---\nJSON export is attached.\n",
        }).catch((e) => ({ sent: false, error: e.message }));

        // If sendAsBusiness failed due to SMTP not configured, try nodemailer directly if available and if business has contact_email
        // For now we rely on sendAsBusiness which already logs to email_log; if it failed we try once more with attachment via direct transport if possible
        if (result.sent) {
            // Also send JSON as attachment via direct nodemailer if possible
            try {
                const settings = mailer.getSettings(business.business_id);
                let nodemailer = null;
                try { nodemailer = require("nodemailer"); } catch {}
                if (nodemailer && settings && settings.smtp_host && settings.smtp_user) {
                    const crypto = require("../lib/crypto");
                    let pass = "";
                    try { pass = crypto.decrypt(settings.smtp_pass_enc); } catch {}
                    if (pass) {
                        const transport = nodemailer.createTransport({
                            host: settings.smtp_host,
                            port: Number(settings.smtp_port) || 587,
                            secure: Number(settings.smtp_port) === 465,
                            auth: { user: settings.smtp_user, pass },
                        });
                        await transport.sendMail({
                            from: `"XEVEN Retention" <${settings.contact_email || settings.smtp_user}>`,
                            to,
                            subject,
                            text,
                            attachments: [{ filename: `${business.business_id}-export.json`, content: json, contentType: "application/json" }],
                        });
                    }
                }
            } catch (e) {
                // ignore attachment failure, primary text mail already sent
            }
            continue;
        } else {
            lastError = result.error;
            logger.warn("retention: mail via business SMTP failed", { businessId: business.business_id, to, error: result.error });
            // Fallback: try system-wide SMTP if env provides it
            try {
                let nodemailer = null;
                try { nodemailer = require("nodemailer"); } catch {}
                const sysHost = process.env.XEVEN_SYSTEM_SMTP_HOST || process.env.SMTP_HOST;
                const sysUser = process.env.XEVEN_SYSTEM_SMTP_USER || process.env.SMTP_USER;
                const sysPass = process.env.XEVEN_SYSTEM_SMTP_PASS || process.env.SMTP_PASS;
                const sysFrom = process.env.XEVEN_SYSTEM_SMTP_FROM || sysUser;
                if (nodemailer && sysHost && sysUser && sysPass) {
                    const transport = nodemailer.createTransport({
                        host: sysHost,
                        port: Number(process.env.XEVEN_SYSTEM_SMTP_PORT || 587),
                        secure: Number(process.env.XEVEN_SYSTEM_SMTP_PORT) === 465,
                        auth: { user: sysUser, pass: sysPass },
                    });
                    await transport.sendMail({
                        from: sysFrom,
                        to,
                        subject,
                        text,
                        attachments: [{ filename: `${business.business_id}-export.json`, content: json }],
                    });
                    logger.info("retention: fallback system SMTP sent", { businessId: business.business_id, to });
                    lastError = null;
                    continue;
                }
            } catch (e) {
                logger.warn("retention: system SMTP fallback failed", { error: e.message });
            }
        }
    }

    if (lastError) {
        // Still consider it "mailed" for audit purposes if we saved to disk, but report failure
        return { sent: false, reason: lastError, recipients };
    }
    return { sent: true, recipients };
}

function deleteBusinessAndData(businessId) {
    const conn = db();
    // Use a transaction to ensure atomic deletion
    const tx = conn.transaction(() => {
        // Tables with business_id FK will cascade, but we explicitly delete those without FK as well
        const tables = [
            "business_configs",
            "business_knowledge",
            "customers",
            "memories",
            "behavioral_events",
            "conversations",
            "conversation_messages",
            "portal_users",
            "portal_settings",
            "feature_flags",
            "business_addons",
            "chrono_schedules",
            "chrono_overrides",
            "chrono_slot_holds",
            "bookings",
            "capability_intents",
            "follow_up_jobs",
            "outcome_events",
            "echo_transcripts",
            "echo_voice_calls",
            "audit_log",
            "email_log",
            "admin_business_access",
        ];
        for (const t of tables) {
            try {
                const exists = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
                if (!exists) continue;
                const cols = conn.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
                if (!cols.includes("business_id")) continue;
                conn.prepare(`DELETE FROM ${t} WHERE business_id=?`).run(businessId);
            } catch {}
        }
        conn.prepare("DELETE FROM businesses WHERE business_id=?").run(businessId);
    });
    tx();
}

async function processDeactivatedBusinesses({ now = Date.now() } = {}) {
    const cutoff = now - RETENTION_MS;
    // Find businesses where active=0 and updated_at <= cutoff
    // If deactivated_at column exists, prefer it
    let hasDeactivatedAt = false;
    try {
        const cols = db().prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
        hasDeactivatedAt = cols.includes("deactivated_at");
    } catch {}

    let rows;
    if (hasDeactivatedAt) {
        rows = db().prepare("SELECT * FROM businesses WHERE active = 0 AND deactivated_at IS NOT NULL AND deactivated_at <= ?").all(cutoff);
        // Fallback to updated_at for old rows without deactivated_at
        const fallback = db().prepare("SELECT * FROM businesses WHERE active = 0 AND (deactivated_at IS NULL) AND updated_at <= ?").all(cutoff);
        rows = rows.concat(fallback);
    } else {
        rows = db().prepare("SELECT * FROM businesses WHERE active = 0 AND updated_at <= ?").all(cutoff);
    }

    const results = [];
    for (const biz of rows) {
        try {
            logger.info("retention: processing deactivated business", { businessId: biz.business_id, businessName: biz.business_name, deactivatedAt: biz.deactivated_at || biz.updated_at });
            const data = gatherBusinessData(biz.business_id);
            if (!data) {
                results.push({ businessId: biz.business_id, status: "skip", reason: "no_data" });
                continue;
            }
            const mailResult = await mailExportToAdmins(biz, data);
            // Record audit before deletion
            try {
                const audit = require("./audit/store");
                audit.record({
                    businessId: biz.business_id,
                    actorType: "system",
                    actorId: "retention",
                    action: "business.purged_after_deactivation",
                    detail: { retentionDays: RETENTION_DAYS, mailed: mailResult.sent, recipients: mailResult.recipients },
                });
            } catch {}
            deleteBusinessAndData(biz.business_id);
            logger.info("retention: purged business", { businessId: biz.business_id, mailed: mailResult.sent });
            results.push({ businessId: biz.business_id, status: "purged", mailed: mailResult.sent, recipients: mailResult.recipients });
        } catch (e) {
            logger.warn("retention: failed to purge business", { businessId: biz.business_id, error: e.message });
            results.push({ businessId: biz.business_id, status: "failed", error: e.message });
        }
    }
    return { checked: rows.length, purged: results.filter((r) => r.status === "purged").length, results };
}

module.exports = { processDeactivatedBusinesses, gatherBusinessData, mailExportToAdmins, RETENTION_DAYS, RETENTION_MS };
