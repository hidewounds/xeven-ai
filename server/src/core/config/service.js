"use strict";

const db = require("../../db").get;
const crypto = require("../../lib/crypto");
const { AppError, badRequest, notFound } = require("../../lib/errors");
const { DEFAULT_CONFIG, BEHAVIOR_EVENT_TYPES, PLANS } = require("./defaults");
// Unified brain: roles removed, one brain with 6 learned patterns (see server/src/core/agent/brain.js)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function now() {
    return Date.now();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeBusinessId(businessId) {
    if (businessId === null || businessId === undefined) return "";
    const value = String(businessId || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .slice(0, 80);
    if (!value) throw badRequest("Business ID is required.", "business_id_required");
    return value;
}

function deepMerge(base, override) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
        return clone(base);
    }
    const result = clone(base) || {};
    for (const key of Object.keys(override)) {
        const value = override[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
            result[key] = deepMerge(result[key] || {}, value);
        } else if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function cleanText(value, maximum) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maximum);
}

// ---------------------------------------------------------------------------
// validation / normalization
// ---------------------------------------------------------------------------

function normalizeStableFields(fields) {
    if (!Array.isArray(fields)) return clone(DEFAULT_CONFIG.memory.stableFields);
    const normalized = [];
    for (const field of fields) {
        if (!field || typeof field.key !== "string" || !field.key.trim()) continue;
        normalized.push({
            key: field.key.trim().toLowerCase().slice(0, 100),
            category: cleanText(field.category || "stable", 50).toLowerCase() || "stable",
            description: cleanText(field.description, 300),
            keywords: Array.isArray(field.keywords)
                ? field.keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim().toLowerCase().slice(0, 100)).slice(0, 20)
                : [],
        });
    }
    return normalized;
}

/** Unified brain: no role slots — all plans have full pattern access (null = unlimited). */
function maxRolesForPlan(plan) {
    return Infinity; // roles removed — one brain has all 6 patterns
}

/** Validate + normalize a full config object onto the canonical defaults. */
function normalizeConfig(config, { plan = "launch", bypassLimit = false } = {}) {
    const merged = deepMerge(DEFAULT_CONFIG, config || {});
    // Unified brain: roles removed — keep legacy role/roles/personas for backward compat read, but do not enforce
    // New configs use assistant.brain = "unified" and ignore role constraints
    const legacyRole = String(merged.assistant?.role || "").trim();
    const legacyRoles = Array.isArray(merged.assistant?.roles) ? merged.assistant.roles : [];
    const legacyPersonas = Array.isArray(merged.assistant?.personas) ? merged.assistant.personas : [];

    merged.version = 1;

    // Normalize to unified brain — preserve legacy fields as stored but ensure brain is unified
    const unifiedRole = "unified";
    const unifiedRoles = ["unified"];

    merged.assistant = {
        name: cleanText(merged.assistant.name, 80) || "XEVEN",
        role: unifiedRole, // unified brain
        roles: unifiedRoles, // one brain, not stacked skills
        personas: [], // personas removed — patterns are learned, not traits
        // Preserve legacy for read but mark deprecated
        _legacyRole: legacyRole,
        _legacyRoles: legacyRoles.slice(0, 5),
        _legacyPersonas: legacyPersonas.slice(0, 5),
        brain: "unified",
        businessDescription: cleanText(merged.assistant.businessDescription, 5000),
        instructions: cleanText(merged.assistant.instructions, 5000),
        personality: cleanText(merged.assistant.personality, 2000),
        tone: cleanText(merged.assistant.tone, 500),
        welcomeMessage: cleanText(merged.assistant.welcomeMessage, 500),
        fallbackMessage: cleanText(merged.assistant.fallbackMessage, 500),
    };

    merged.model = {
        provider: ["openai-compatible", "mock", "inherit"].includes(merged.model?.provider)
            ? merged.model.provider
            : "inherit",
        model: cleanText(merged.model?.model, 120),
        baseUrl: cleanText(merged.model?.baseUrl, 300),
        apiKey: typeof merged.model?.apiKey === "string" ? merged.model.apiKey.slice(0, 500) : "",
        temperature: clampNumber(merged.model?.temperature, 0, 2, 0.7),
        timeoutMs: clampNumber(merged.model?.timeoutMs, 5_000, 600_000, 120_000),
    };

    merged.memory = {
        enabled: merged.memory?.enabled !== false,
        maxMemories: clampNumber(merged.memory?.maxMemories, 1, 500, 50),
        allowExplicitRemember: merged.memory?.allowExplicitRemember !== false,
        stableFields: normalizeStableFields(merged.memory?.stableFields),
    };

    const events = {};
    const sourceEvents = merged.behavior?.events && typeof merged.behavior.events === "object"
        ? merged.behavior.events
        : {};
    for (const eventType of BEHAVIOR_EVENT_TYPES) {
        const event = sourceEvents[eventType] || {};
        events[eventType] = {
            enabled: event.enabled !== false,
            retentionDays: clampNumber(event.retentionDays, 1, 3650, DEFAULT_CONFIG.behavior.events[eventType].retentionDays),
        };
    }

    merged.behavior = {
        enabled: merged.behavior?.enabled !== false,
        maxEvents: clampNumber(merged.behavior?.maxEvents, 10, 10_000, 100),
        defaultRetentionDays: clampNumber(merged.behavior?.defaultRetentionDays, 1, 3650, 30),
        events,
    };

    merged.context = {
        maxMemories: clampNumber(merged.context?.maxMemories, 0, 20, 5),
        maxBehavior: clampNumber(merged.context?.maxBehavior, 0, 30, 10),
        maxKnowledge: clampNumber(merged.context?.maxKnowledge, 0, 12, 4),
        maxConversationMessages: clampNumber(merged.context?.maxConversationMessages, 2, 50, 20),
        minimumMemoryScore: clampNumber(merged.context?.minimumMemoryScore, 0, 50, 1),
        minimumBehaviorScore: clampNumber(merged.context?.minimumBehaviorScore, 0, 50, 1),
        maxContextTokens: clampNumber(merged.context?.maxContextTokens, 500, 32_000, 6000),
    };

    const featureCaps = merged.features?.capabilities;
    const sanitizedCaps = {};
    if (featureCaps && typeof featureCaps === "object" && !Array.isArray(featureCaps)) {
        for (const [key, value] of Object.entries(featureCaps).slice(0, 50)) {
            if (typeof key === "string" && key.trim()) sanitizedCaps[key.trim().slice(0, 100)] = value !== false;
        }
    }

    merged.features = {
        conversations: merged.features?.conversations !== false,
        knowledge: merged.features?.knowledge !== false,
        capabilities: { ...DEFAULT_CONFIG.features.capabilities, ...sanitizedCaps },
    };

    merged.security = {
        widgetEnabled: merged.security?.widgetEnabled !== false,
        // Embed allowlist for the widget surface. Empty = allow any origin
        // (open-by-default) with a dashboard warning in production.
        allowedOrigins: Array.isArray(merged.security?.allowedOrigins)
            ? merged.security.allowedOrigins.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim().slice(0, 200)).slice(0, 20)
            : [],
    };

    // chrono (schedule engine) — mirrors DAYS schedule from chrono/schedule.js
    merged.chrono = {
        timezone: cleanText(merged.chrono?.timezone, 80) || DEFAULT_CONFIG.chrono.timezone,
        slotDuration: clampNumber(merged.chrono?.slotDuration, 10, 240, DEFAULT_CONFIG.chrono.slotDuration),
        bufferMinutes: clampNumber(merged.chrono?.bufferMinutes, 0, 120, DEFAULT_CONFIG.chrono.bufferMinutes),
        minNoticeMinutes: clampNumber(merged.chrono?.minNoticeMinutes, 0, 1440, DEFAULT_CONFIG.chrono.minNoticeMinutes),
        maxDaysAhead: clampNumber(merged.chrono?.maxDaysAhead, 1, 365, DEFAULT_CONFIG.chrono.maxDaysAhead),
        maxSeatsPerSlot: clampNumber(merged.chrono?.maxSeatsPerSlot, 1, 100, DEFAULT_CONFIG.chrono.maxSeatsPerSlot),
        hosts: Array.isArray(merged.chrono?.hosts) ? merged.chrono.hosts.filter((h) => h && typeof h.name === "string" && h.name.trim()).slice(0, 20).map((h) => ({ name: cleanText(h.name, 80), email: cleanText(h.email || "", 120).toLowerCase() })) : [],
        weekly: merged.chrono?.weekly && typeof merged.chrono.weekly === "object" ? merged.chrono.weekly : DEFAULT_CONFIG.chrono.weekly,
    };

    merged.echo = {
        enabled: merged.echo?.enabled === true,
        defaultLanguage: cleanText(merged.echo?.defaultLanguage, 10).toLowerCase() || DEFAULT_CONFIG.echo.defaultLanguage,
        model: cleanText(merged.echo?.model, 20).toLowerCase() || DEFAULT_CONFIG.echo.model,
        sidecarUrl: cleanText(merged.echo?.sidecarUrl, 300) || DEFAULT_CONFIG.echo.sidecarUrl,
        wordTimestamps: merged.echo?.wordTimestamps === true,
        initialPrompt: cleanText(merged.echo?.initialPrompt, 600) || DEFAULT_CONFIG.echo.initialPrompt,
    };

    merged.call = {
        greetingTemplate: cleanText(merged.call?.greetingTemplate, 600) || DEFAULT_CONFIG.call.greetingTemplate,
        handoffPhone: cleanText(merged.call?.handoffPhone, 40),
        handoffEmail: cleanText(merged.call?.handoffEmail, 120).toLowerCase(),
    };

    merged.addons = {
        voice_channel: merged.addons?.voice_channel === true,
        multilanguage: merged.addons?.multilanguage === true,
        custom_behaviour: merged.addons?.custom_behaviour === true || merged.addons?.custom_behaviour === true,
    };

    // Custom Agent Behaviour Builder — plan-gated, business-defined overrides
    const CUSTOM_PATTERNS = ["customer_support","sales","shopping_assistant","product_advisor","lead_qualification","general_assistant"];
    const planLimits = PLANS[plan]?.limits || PLANS.launch.limits;
    const maxCustomRules = bypassLimit ? Infinity : (planLimits.maxCustomRules ?? planLimits.customBehaviours ?? 0);
    // Add-on can grant extra 5 rules on launch when custom_behaviour add-on enabled (and not bypass)
    let effectiveMax = maxCustomRules;
    try {
        if (!bypassLimit && plan === "launch" && merged.addons?.custom_behaviour) {
            effectiveMax = Math.max(effectiveMax, 5);
        }
        // Unlimited plan owns everything (already Infinity)
    } catch {}
    const rawRules = Array.isArray(merged.agentBehaviour?.rules) ? merged.agentBehaviour.rules : (Array.isArray(merged.agentBehaviour) ? merged.agentBehaviour : []);
    const normalizedRules = [];
    for (const r of rawRules.slice(0, effectiveMax === Infinity ? 100 : effectiveMax)) {
        if (!r || typeof r !== "object") continue;
        const name = cleanText(r.name, 80);
        const trigger = cleanText(r.trigger, 300);
        if (!name && !trigger) continue;
        const primaryPattern = CUSTOM_PATTERNS.includes(String(r.primaryPattern||"").trim()) ? String(r.primaryPattern).trim() : (CUSTOM_PATTERNS.includes(String(r.pattern||"").trim()) ? String(r.pattern).trim() : "general_assistant");
        normalizedRules.push({
            id: cleanText(r.id, 40) || `rule_${Math.random().toString(36).slice(2,8)}`,
            name: name || `Behaviour ${normalizedRules.length+1}`,
            trigger: trigger,
            triggerType: ["keyword","situation","regex"].includes(String(r.triggerType||"").trim()) ? String(r.triggerType).trim() : "keyword",
            primaryPattern,
            pattern: primaryPattern, // alias
            tone: cleanText(r.tone, 300),
            instructions: cleanText(r.instructions, 2000),
            weightBoost: clampNumber(r.weightBoost, 0.1, 3.0, 1.5),
            priority: clampNumber(r.priority, 1, 10, 5),
            enabled: r.enabled !== false,
        });
    }
    // Sort by priority desc
    normalizedRules.sort((a,b) => b.priority - a.priority);
    merged.agentBehaviour = {
        enabled: merged.agentBehaviour?.enabled !== false,
        rules: normalizedRules,
        maxRules: effectiveMax,
        planLimit: maxCustomRules,
    };
    // Backward compat: also expose as customBehaviour
    merged.customBehaviour = merged.agentBehaviour;

    // expose businessId for downstream capability gating that needs addon checks
    merged.__businessId = merged.__businessId || null;

    // Unified brain: no role stacking limits — one brain has all patterns

    return merged;
}

/**
 * Strip secrets from a config before returning it through any API.
 * This is the ONLY shape of config that may ever leave the server.
 */
function sanitizeConfig(config) {
    const safe = clone(config);
    if (safe.model) {
        safe.model.apiKey = safe.model.apiKey ? "[configured]" : "";
    }
    return safe;
}

function validateConfigPatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw badRequest("Configuration must be a JSON object.");
    }
    const allowedSections = new Set(["assistant", "model", "memory", "behavior", "context", "features", "security", "chrono", "echo", "call", "addons", "agentBehaviour", "customBehaviour"]);
    for (const key of Object.keys(patch)) {
        if (!allowedSections.has(key)) {
            throw badRequest(`Unknown configuration section: ${key}`);
        }
        if (!patch[key] || typeof patch[key] !== "object" || Array.isArray(patch[key])) {
            throw badRequest(`Configuration section "${key}" must be an object.`);
        }
    }
    if (patch.assistant && patch.assistant.role !== undefined) {
        // unknown roles are coerced during normalization; nothing to reject
    }
    if (patch.agentBehaviour || patch.customBehaviour) {
        const ab = patch.agentBehaviour || patch.customBehaviour;
        if (ab.rules !== undefined && !Array.isArray(ab.rules)) {
            throw badRequest("agentBehaviour.rules must be an array.");
        }
        if (ab.rules && ab.rules.length > 100) {
            throw badRequest("Too many custom behaviour rules (max 100).");
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// businesses
// ---------------------------------------------------------------------------

function getBusiness(businessId) {
    const id = normalizeBusinessId(businessId);
    try {
        return (
            db()
                .prepare(
                    `SELECT id, business_id, business_name, integration_key, widget_public_key, active, plan, created_at, updated_at, deactivated_at
                     FROM businesses WHERE business_id = ? LIMIT 1`
                )
                .get(id) || null
        );
    } catch {
        return (
            db()
                .prepare(
                    `SELECT id, business_id, business_name, integration_key, active, plan, created_at, updated_at
                     FROM businesses WHERE business_id = ? LIMIT 1`
                )
                .get(id) || null
        );
    }
}

function getBusinessByKey(integrationKey) {
    let key = String(integrationKey || "").trim();
    // COMPAT (pre-rebrand embeds): accept legacy nova_pk_ keys by mapping
    // them onto the current prefix. New keys are always issued as xeven_pk_.
    // Remove once all embeds migrate (keys, header, snippet URL, global).
    if (/^nova_pk_/.test(key)) key = key.replace(/^nova_pk_/, "xeven_pk_");
    if (!key || key.length > 500) return null;
    const withPub = `SELECT id, business_id, business_name, integration_key, widget_public_key, active, plan, created_at, updated_at, deactivated_at
                     FROM businesses WHERE integration_key = ? OR widget_public_key = ? LIMIT 1`;
    const legacyNew = `SELECT id, business_id, business_name, integration_key, active, plan, created_at, updated_at, deactivated_at
                     FROM businesses WHERE integration_key = ? LIMIT 1`;
    const legacyOld = `SELECT id, business_id, business_name, integration_key, active, plan, created_at, updated_at
                     FROM businesses WHERE integration_key = ? LIMIT 1`;
    let row = null;
    try {
        row = db().prepare(withPub).get(key, key) || null;
    } catch {
        try {
            row = db().prepare(legacyNew).get(key) || null;
        } catch {
            row = db().prepare(legacyOld).get(key) || null;
        }
    }
    if (!row) return null;
    // Attach the credential kind: publishable keys are widget-scoped,
    // secret + legacy keys keep full platform access.
    if (row.widget_public_key && row.widget_public_key === key) row._keyKind = "publishable";
    else if (row.integration_key && row.integration_key === key) {
        row._keyKind = crypto.classifyIntegrationKey(key) === "secret" ? "secret" : "legacy";
    } else return null;
    return row;
}

function listBusinesses({ includeInactive = false } = {}) {
    try {
        const rows = db().prepare(`SELECT id, business_id, business_name, integration_key, widget_public_key, active, plan, created_at, updated_at, deactivated_at FROM businesses ORDER BY created_at ASC`).all();
        return includeInactive ? rows : rows.filter((row) => row.active);
    } catch {
        const rows = db().prepare(`SELECT id, business_id, business_name, integration_key, active, plan, created_at, updated_at FROM businesses ORDER BY created_at ASC`).all();
        return includeInactive ? rows : rows.filter((row) => row.active);
    }
}

function createBusiness({ businessId, businessName, config = {} }) {
    const id = businessId ? normalizeBusinessId(businessId) : normalizeBusinessId(String(businessName || `business_${crypto.randomHex(4)}`));
    const name = cleanText(businessName, 200);
    if (!name) throw badRequest("Business name is required.");
    if (getBusiness(id)) throw new AppError(409, "business_exists", "A business with this ID already exists.");

    const timestamp = now();
    const integrationKey = crypto.generateSecretKey();
    const widgetPublicKey = crypto.generatePublishableKey();
    const normalized = normalizeConfig({ ...config, version: 1 });

    db().transaction(() => {
        db()
            .prepare(
                `INSERT INTO businesses (business_id, business_name, integration_key, widget_public_key, active, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 1, ?, ?)`
            )
            .run(id, name, integrationKey, widgetPublicKey, timestamp, timestamp);

        db()
            .prepare(
                `INSERT INTO business_configs (business_id, config_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(business_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
            )
            .run(id, JSON.stringify(normalized), timestamp, timestamp);
    })();

    return {
        business: publicBusiness(getBusiness(id)),
        integrationKey,
        widgetPublicKey,
        config: sanitizeConfig(normalized),
    };
}

function publicBusiness(row, { includeKey = false } = {}) {
    if (!row) return null;
    const base = {
        businessId: row.business_id,
        businessName: row.business_name,
        active: Boolean(row.active),
        plan: PLANS[row.plan] ? row.plan : "launch",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deactivatedAt: row.deactivated_at || null,
    };
    if (includeKey) base.integrationKey = row.integration_key;
    // Publishable key is safe to show in the dashboard snippet by design.
    base.widgetPublicKey = row.widget_public_key || null;
    return base;
}

/** Change a business's commercial plan (super-admin operation). */
function setBusinessPlan(businessId, plan) {
    const id = normalizeBusinessId(businessId);
    const normalized = String(plan || "").trim().toLowerCase();
    if (!PLANS[normalized]) {
        throw badRequest(`Unknown plan "${normalized}". Valid plans: ${Object.keys(PLANS).join(", ")}.`, "unknown_plan");
    }
    const existing = getBusiness(id);
    if (!existing) throw notFound("Business not found.");
    db().prepare(`UPDATE businesses SET plan = ?, updated_at = ? WHERE business_id = ?`).run(normalized, now(), id);

    // Unified brain: no role re-clamping needed — all plans have full pattern access

    return publicBusiness(getBusiness(id));
}

function updateBusinessIdentity(businessId, { businessName, active } = {}) {
    const id = normalizeBusinessId(businessId);
    const existing = getBusiness(id);
    if (!existing) throw notFound("Business not found.");

    const updates = {};
    if (businessName !== undefined) {
        const name = cleanText(businessName, 200);
        if (!name) throw badRequest("Business name cannot be empty.");
        updates.business_name = name;
    }
    if (active !== undefined) {
        updates.active = active ? 1 : 0;
        // Track deactivation time for 15-day retention purge
        updates.deactivated_at = active ? null : now();
    }

    if (Object.keys(updates).length > 0) {
        const hasDeactivatedAt = (() => {
            try {
                const cols = db().prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
                return cols.includes("deactivated_at");
            } catch { return false; }
        })();
        if (hasDeactivatedAt) {
            db()
                .prepare(`UPDATE businesses SET business_name = COALESCE(?, business_name), active = COALESCE(?, active), deactivated_at = ?, updated_at = ? WHERE business_id = ?`)
                .run(updates.business_name ?? null, updates.active ?? null, updates.deactivated_at ?? null, now(), id);
        } else {
            db()
                .prepare(`UPDATE businesses SET business_name = COALESCE(?, business_name), active = COALESCE(?, active), updated_at = ? WHERE business_id = ?`)
                .run(updates.business_name ?? null, updates.active ?? null, now(), id);
        }
    }
    return publicBusiness(getBusiness(id));
}

function rotateIntegrationKey(businessId) {
    const id = normalizeBusinessId(businessId);
    const existing = getBusiness(id);
    if (!existing) throw notFound("Business not found.");
    // The publishable key stays stable (it is embedded in deployed snippets);
    // only the secret rotates. Legacy businesses without a publishable key
    // keep the legacy single-key format.
    const key = existing.widget_public_key ? crypto.generateSecretKey() : crypto.generateIntegrationKey();
    db().prepare(`UPDATE businesses SET integration_key = ?, updated_at = ? WHERE business_id = ?`).run(key, now(), id);
    return { integrationKey: key, widgetPublicKey: existing.widget_public_key || null };
}

// ---------------------------------------------------------------------------
// configuration storage
// ---------------------------------------------------------------------------

function tryDecryptApiKey(value) {
    if (!value || typeof value !== "string") return value;
    if (value === "[configured]" || !value.includes(":")) return value;
    // Encrypted format is iv:tag:cipher (hex)
    if ((value.match(/:/g) || []).length !== 2) return value;
    try {
        const dec = crypto.decrypt(value);
        return dec || value;
    } catch {
        return value;
    }
}

function tryEncryptApiKey(value) {
    if (!value || typeof value !== "string") return value;
    if (value === "[configured]" || value.includes(":")) return value; // already encrypted or placeholder
    if (!value.trim()) return "";
    try {
        return crypto.encrypt(value);
    } catch {
        return value; // fallback to plain if encryption not configured
    }
}

function getConfig(businessId, { bypassLimit = false } = {}) {
    const id = normalizeBusinessId(businessId);
    const row = db().prepare(`SELECT config_json FROM business_configs WHERE business_id = ? LIMIT 1`).get(id);

    let stored = {};
    if (row?.config_json) {
        try {
            stored = JSON.parse(row.config_json);
            // Decrypt at-rest apiKey if present (ready-on-setup: if decrypt fails, keep as-is)
            if (stored.model && stored.model.apiKey) {
                stored.model.apiKey = tryDecryptApiKey(stored.model.apiKey);
            }
        } catch {
            stored = {};
        }
    }

    const businessRow = getBusiness(id);
    const cfg = normalizeConfig(deepMerge(DEFAULT_CONFIG, stored), { plan: businessRow?.plan, bypassLimit });
    cfg.__businessId = id;
    // surface addon entitlements inside config for convenience (read-only view)
    try {
        const { listAddons } = require("../addons/store");
        const addons = listAddons(id);
        cfg.addons = Object.fromEntries(addons.map((a) => [a.key, a.enabled]));
        cfg.__addons = addons;
    } catch {}
    return cfg;
}

function saveRawConfig(businessId, normalizedConfig) {
    const id = normalizeBusinessId(businessId);
    const timestamp = now();
    // Encrypt apiKey at-rest (ready-on-setup: if no secret, falls back to plain)
    const toStore = JSON.parse(JSON.stringify(normalizedConfig));
    if (toStore.model && toStore.model.apiKey && toStore.model.apiKey !== "[configured]") {
        toStore.model.apiKey = tryEncryptApiKey(toStore.model.apiKey);
    }
    db()
        .prepare(
            `INSERT INTO business_configs (business_id, config_json, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(business_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
        )
        .run(id, JSON.stringify(toStore), timestamp, timestamp);
}

/** Deep-merge a validated patch into stored config and persist. */
function updateConfig(businessId, patch, { bypassLimit = false } = {}) {
    validateConfigPatch(patch);
    // Sanitized placeholder "[configured]" must not overwrite the real key
    if (patch.model && patch.model.apiKey === "[configured]") {
        delete patch.model.apiKey;
        if (patch.model && Object.keys(patch.model).length === 0) delete patch.model;
        if (Object.keys(patch).length === 0) return getConfig(businessId, { bypassLimit });
    }
    // Always read the true stored stack (bypass) so an admin's over-limit work
    // isn't silently truncated when a portal edits unrelated fields.
    const current = getConfig(businessId, { bypassLimit: true });
    const plan = getBusiness(businessId)?.plan || "launch";

    // Unified brain: roles deprecated — keep legacy roles as no-ops for backward compat, no limits
    // Strip legacy role fields and enforce unified brain
    if (patch?.assistant) {
        // Preserve legacy role/roles if sent, but map to unified (no enforcement)
        if (Array.isArray(patch.assistant.roles) || typeof patch.assistant.role === "string") {
            // Legacy client still sends roles — normalize to unified, no limit
            patch.assistant.role = "unified";
            patch.assistant.roles = ["unified"];
            // Also clear personas if present (deprecated)
            if (patch.assistant.personas) delete patch.assistant.personas;
        }
    }

    const next = normalizeConfig(deepMerge(current, patch), { plan, bypassLimit: true });
    saveRawConfig(businessId, next);
    return next;
}

module.exports = {
    normalizeBusinessId,
    deepMerge,
    normalizeConfig,
    sanitizeConfig,
    validateConfigPatch,
    maxRolesForPlan,
    getBusiness,
    getBusinessByKey,
    listBusinesses,
    publicBusiness,
    createBusiness,
    updateBusinessIdentity,
    setBusinessPlan,
    rotateIntegrationKey,
    getConfig,
    updateConfig,
};
