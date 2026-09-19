"use strict";

/**
 * XEVEN Add-ons — entitlements per business.
 * Add-ons are attachable capabilities (voice_channel, multilanguage) that
 * the business enables from their portal. They gate features at the capability
 * and route layers; Unlimited plan auto-enables everything.
 */

const db = require("../../db").get;

const ADDON_KEYS = ["voice_channel", "multilanguage", "custom_behaviour"];

const ADDON_META = {
    voice_channel: {
        label: "Voice Channel",
        description: "Voice agent that answers customer calls (echo STT + call greeting + human handoff as last resort).",
        requiresRole: "voice_receptionist",
    },
    multilanguage: {
        label: "Multi-Language",
        description: "Customer can speak/type in any language; agent auto-detects and replies in kind.",
        requiresRole: null,
    },
    custom_behaviour: {
        label: "Custom Behaviour Pack",
        description: "Add 5 extra custom agent behaviour rules (trigger → pattern + tone + instructions). For Launch (0→5) or Growth (3→8). Scale/Unlimited include enough.",
        requiresRole: null,
    },
};

function isEnabled(businessId, key) {
    if (!ADDON_KEYS.includes(key)) return false;
    // Unlimited plan owns everything
    try {
        const biz = db().prepare("SELECT plan FROM businesses WHERE business_id=?").get(businessId);
        if (biz && biz.plan === "unlimited") return true;
    } catch {}
    const row = db().prepare("SELECT enabled FROM business_addons WHERE business_id=? AND addon_key=?").get(businessId, key);
    return Boolean(row && row.enabled);
}

function listAddons(businessId) {
    const rows = db().prepare("SELECT addon_key, enabled, config_json FROM business_addons WHERE business_id=?").all(businessId);
    const map = new Map(rows.map((r) => [r.addon_key, r]));
    return ADDON_KEYS.map((key) => {
        const row = map.get(key);
        let config = {};
        try { config = JSON.parse(row?.config_json || "{}"); } catch {}
        // unlimited auto-enabled view
        let enabled = Boolean(row && row.enabled);
        try {
            const biz = db().prepare("SELECT plan FROM businesses WHERE business_id=?").get(businessId);
            if (biz && biz.plan === "unlimited") enabled = true;
        } catch {}
        return { key, enabled, config, meta: ADDON_META[key] };
    });
}

function setAddon(businessId, key, { enabled, config } = {}) {
    if (!ADDON_KEYS.includes(key)) throw new Error(`Unknown addon ${key}`);
    const existing = db().prepare("SELECT config_json FROM business_addons WHERE business_id=? AND addon_key=?").get(businessId, key);
    let mergedConfig = {};
    try { mergedConfig = JSON.parse(existing?.config_json || "{}"); } catch {}
    if (config && typeof config === "object") {
        mergedConfig = { ...mergedConfig, ...config };
        // sanitize keys
        const clean = {};
        for (const [k, v] of Object.entries(mergedConfig).slice(0, 20)) {
            clean[String(k).slice(0, 80)] = typeof v === "string" ? v.slice(0, 2000) : v;
        }
        mergedConfig = clean;
    }
    const nextEnabled = enabled === undefined ? (existing ? Boolean(existing.enabled) : false) : Boolean(enabled);
    db().prepare(
        "INSERT INTO business_addons (business_id, addon_key, enabled, config_json, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(business_id, addon_key) DO UPDATE SET enabled=excluded.enabled, config_json=excluded.config_json, updated_at=excluded.updated_at"
    ).run(businessId, key, nextEnabled ? 1 : 0, JSON.stringify(mergedConfig), Date.now());
    return { key, enabled: nextEnabled, config: mergedConfig };
}

function getAddonConfig(businessId, key) {
    const row = db().prepare("SELECT config_json FROM business_addons WHERE business_id=? AND addon_key=?").get(businessId, key);
    if (!row) return {};
    try { return JSON.parse(row.config_json); } catch { return {}; }
}

module.exports = { ADDON_KEYS, ADDON_META, isEnabled, listAddons, setAddon, getAddonConfig };
