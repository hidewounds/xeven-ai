"use strict";

/**
 * Outbound mail — ALWAYS from the business's own email identity.
 *
 * XEVEN is staff, not a sender: it owns no addresses. Every follow-up and
 * handoff email goes out through the business's SMTP credentials (configured
 * in their portal), from their address, on their behalf.
 */

const db = require("../db").get;
const crypto = require("../lib/crypto");

let nodemailer = null;
try {
    nodemailer = require("nodemailer");
} catch {
    // dependency missing — mail stays disabled rather than crashing the server
}

function getSettings(businessId) {
    return db().prepare("SELECT * FROM portal_settings WHERE business_id = ?").get(businessId) || null;
}

function ensureSettings(businessId) {
    const existing = getSettings(businessId);
    if (existing) return existing;
    db().prepare(
        `INSERT INTO portal_settings (business_id, updated_at) VALUES (?, ?)
         ON CONFLICT (business_id) DO NOTHING`
    ).run(businessId, Date.now());
    return getSettings(businessId);
}

/** Decrypt-on-read helper for the stored SMTP password. */
function smtpPassword(settings) {
    if (!settings || !settings.smtp_pass_enc) return "";
    try {
        return crypto.decrypt(settings.smtp_pass_enc);
    } catch {
        return "";
    }
}

/** Is this business fully configured to send mail as itself? */
function canSend(businessId) {
    const s = ensureSettings(businessId);
    const ok = Boolean(
        nodemailer && s.contact_email && s.smtp_host && s.smtp_user && smtpPassword(s)
    );
    return { ok, reason: ok ? null : "SMTP not configured (need contact email + host + user + password)", settings: s };
}

/**
 * Send one email AS the business. Logs every attempt to email_log.
 * Supports idempotency via idempotencyKey to prevent duplicate sends.
 * Returns { sent, error, idempotentReplay }.
 */
async function sendAsBusiness(businessId, { to, subject, text, idempotencyKey }) {
    const s = ensureSettings(businessId);
    const capability = canSend(businessId);

    let status = "failed";
    let error = capability.reason || "unknown";

    // Check idempotency
    if (idempotencyKey) {
        const crypto = require("../lib/crypto");
        const keyHash = crypto.createHash("sha256").update(`${businessId}:${idempotencyKey}`).digest("hex");
        const existing = db().prepare(
            `SELECT status FROM email_log WHERE business_id = ? AND to_email = ? AND subject = ? AND kind = 'outbound' AND created_at > ? ORDER BY created_at DESC LIMIT 1`
        ).get(businessId, String(to), String(subject || "").slice(0, 300), Date.now() - 24 * 60 * 60 * 1000);
        if (existing) {
            return { sent: existing.status === "sent", error: existing.error, idempotentReplay: true };
        }
    }

    if (capability.ok) {
        try {
            const transport = nodemailer.createTransport({
                host: s.smtp_host,
                port: Number(s.smtp_port) || 587,
                secure: Number(s.smtp_port) === 465,
                auth: { user: s.smtp_user, pass: smtpPassword(s) },
            });
            await transport.sendMail({
                from: `"${s.smtp_from_name || "XEVEN Assistant"}" <${s.contact_email}>`,
                to,
                subject,
                text,
            });
            status = "sent";
            error = "";
        } catch (err) {
            error = err.message;
        }
    }

    db().prepare(
        "INSERT INTO email_log (business_id, to_email, subject, kind, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(businessId, String(to), String(subject || "").slice(0, 300), "outbound", status, String(error).slice(0, 500), Date.now());

    return { sent: status === "sent", error };
}

module.exports = { sendAsBusiness, canSend, getSettings, ensureSettings };
