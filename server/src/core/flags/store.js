"use strict";

/**
 * Per-business capability flags. The FOUNDER (super admin) decides what each
 * business may self-manage in their portal; everything defaults to OFF so a
 * new business can do nothing until explicitly allowed.
 */

const db = require("../../db").get;

const FLAG_KEYS = [
    "portal_enabled",       // master switch — without it the portal login is dead
    "knowledge_edit",       // add/edit their FAQs & knowledge
    "edit_contact",         // set contact email/phone/hours (email handoff identity)
    "edit_tone",            // tweak welcome message / assistant tone
    "view_analytics",
    "view_customers",       // customer list + erasure button
    "email_handoff",        // XEVEN offers their email when customers ask for a human
    "edit_followup",        // configure follow-up days/intervals + SMTP
    "weekly_digest",        // receive the Monday weekly performance email
];

const DEFAULTS = Object.fromEntries(FLAG_KEYS.map((k) => [k, false]));

function getFlags(businessId) {
    const row = db().prepare("SELECT flags_json FROM feature_flags WHERE business_id = ?").get(businessId);
    let stored = {};
    try {
        stored = JSON.parse(row?.flags_json || "{}");
    } catch {}
    return { ...DEFAULTS, ...stored };
}

function setFlags(businessId, patch = {}) {
    const clean = {};
    for (const key of FLAG_KEYS) {
        if (key in patch) clean[key] = Boolean(patch[key]);
    }
    const merged = { ...getFlags(businessId), ...clean };
    db().prepare(
        `INSERT INTO feature_flags (business_id, flags_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (business_id) DO UPDATE SET flags_json = excluded.flags_json, updated_at = excluded.updated_at`
    ).run(businessId, JSON.stringify(merged), Date.now());
    return getFlags(businessId);
}

module.exports = { getFlags, setFlags, FLAG_KEYS };
