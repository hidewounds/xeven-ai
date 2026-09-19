"use strict";

/**
 * Business Portal API. Every route:
 *   1. authenticates a portal user (scoped to ONE business),
 *   2. enforces the founder-controlled feature flags,
 *   3. touches only req.xeven.businessId data.
 */

const express = require("express");
const portal = require("../../auth/portal");
const flagsStore = require("../../core/flags/store");
const configService = require("../../core/config/service");
const knowledge = require("../../core/knowledge/store");
const customers = require("../../core/customers/store");
const analytics = require("../../core/analytics/service");
const conversations = require("../../core/conversations/store");
const mailer = require("../../core/mailer");
const followUps = require("../../core/followups/engine");
const digests = require("../../core/digests/engine");
const audit = require("../../core/audit/store");
const db = require("../../db").get;
const crypto = require("../../lib/crypto");
const { badRequest } = require("../../lib/errors");

const router = express.Router();

// --- auth -------------------------------------------------------------------

router.post("/auth/login", (req, res, next) => {
    try {
        const row = portal.verifyCredentials({ email: (req.body || {}).email, password: (req.body || {}).password });
        const { token, expiresAt } = portal.signPortalToken(row);
        audit.record({ businessId: row.business_id, actorType: "portal", actorId: row.portal_uid, action: "portal.login", ip: req.ip });
        portal.setPortalCookie(res, token);
        res.json({ user: portal.publicUser(row), token, tokenExpiresAt: expiresAt, cookieAuth: true });
    } catch (error) {
        next(error);
    }
});

router.post("/auth/logout", portal.requirePortal, (req, res) => {
    audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.logout", ip: req.ip });
    portal.clearPortalCookie(res);
    res.json({ success: true });
});

// ── Public portal assets (no auth) — voice client JS + test page are static demos
const path = require("path");
const portalRoot = path.join(__dirname, "..", "..", "..", "..", "client", "portal");
router.get("/voice/client.js", (req, res) => {
    res.sendFile(path.join(portalRoot, "xeven-voice-client.js"));
});
router.get("/voice/test", (req, res) => {
    res.sendFile(path.join(portalRoot, "voice-test.html"));
});

// Everything below requires a portal session.
router.use(portal.requirePortal);

router.get("/me", (req, res) => {
    const biz = configService.getBusiness(req.xeven.businessId);
    const settings = mailer.getSettings(req.xeven.businessId);
    let assistant = { welcomeMessage: "", tone: "", name: "XEVEN", role: "unified", roles: ["unified"], brain: "unified", businessDescription: "", instructions: "", personality: "", fallbackMessage: "" };
    let plan = biz?.plan || "launch";
    let maxRoles = null; // unified brain: no role limit
    let allRoleKeys = [];
    let brainPatterns = [];
    let agentBehaviour = { enabled: true, rules: [], maxRules: 0, planLimit: 0 };
    try {
        const { PLANS } = require("../../core/config/defaults");
        const { PATTERN_IDS } = require("../../core/agent/brain");
        allRoleKeys = PATTERN_IDS; // for backward compat, now patterns
        brainPatterns = PATTERN_IDS;
        maxRoles = null; // unlimited — one brain has all 6 patterns
        const config = configService.getConfig(req.xeven.businessId, { bypassLimit: true });
        assistant = {
            name: (config.assistant && config.assistant.name) || "XEVEN",
            role: "unified",
            roles: ["unified"],
            brain: "unified",
            businessDescription: (config.assistant && config.assistant.businessDescription) || "",
            instructions: (config.assistant && config.assistant.instructions) || "",
            personality: (config.assistant && config.assistant.personality) || "",
            tone: (config.assistant && config.assistant.tone) || "",
            welcomeMessage: (config.assistant && config.assistant.welcomeMessage) || "",
            fallbackMessage: (config.assistant && config.assistant.fallbackMessage) || "",
        };
        agentBehaviour = config.agentBehaviour || config.customBehaviour || { enabled: true, rules: [], maxRules: 0, planLimit: 0 };
    } catch {}
    res.json({
        user: req.xevenPortal,
        business: { businessId: biz?.business_id, name: biz?.business_name, plan },
        plan,
        maxRoles,
        roleKeys: allRoleKeys,
        brainPatterns,
        brain: "unified",
        flags: req.xevenFlags,
        agentBehaviour,
        settings: {
            contactEmail: settings?.contact_email || "",
            contactPhone: settings?.contact_phone || "",
            businessHours: settings?.business_hours || "",
            followUp: {
                enabled: Boolean(settings?.follow_up_enabled),
                firstDays: settings?.follow_up_first_days ?? 1,
                maxAttempts: settings?.follow_up_max_attempts ?? 3,
                intervalDays: settings?.follow_up_interval_days ?? 2,
            },
            digestEmail: settings?.digest_email || "",
            smtpConfigured: Boolean(settings?.smtp_host && settings?.smtp_user),
            smtpUser: settings?.smtp_user || "",
            smtpHost: settings?.smtp_host || "",
            smtpPort: settings?.smtp_port || 587,
            smtpFromName: settings?.smtp_from_name || "",
            welcomeMessage: assistant.welcomeMessage,
            tone: assistant.tone,
            assistant,
        },
        assistant,
    });
});

// --- knowledge (flag: knowledge_edit) ---------------------------------------

router.get("/knowledge", portal.requireFlag("knowledge_edit"), (req, res) => {
    const result = knowledge.listKnowledge(req.xeven.businessId);
    const items = Array.isArray(result) ? result : (result.items || []);
    res.json({ items, total: Array.isArray(result) ? result.length : (result.total || items.length) });
});

router.get("/knowledge/search", portal.requireFlag("knowledge_edit"), (req, res) => {
    const q = String(req.query.q || req.query.query || "").trim();
    const limit = Math.min(12, Math.max(1, Number(req.query.limit) || 4));
    if (!q) return res.json({ query: "", items: [] });
    const items = knowledge.searchKnowledge(req.xeven.businessId, q, limit);
    res.json({ query: q, items });
});

router.post("/knowledge", portal.requireFlag("knowledge_edit"), (req, res, next) => {
    try {
        const body = req.body || {};
        const item = knowledge.createKnowledgeItem({
            businessId: req.xeven.businessId,
            title: body.title,
            knowledgeType: body.knowledgeType || body.type || "faq",
            content: body.content,
            metadata: body.metadata,
        });
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.knowledge.created" });
        res.status(201).json({ item });
    } catch (error) {
        next(error);
    }
});

router.post("/knowledge/bulk", portal.requireFlag("knowledge_edit"), (req, res, next) => {
    try {
        const body = req.body || {};
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) throw badRequest("Provide items: [{title, content, knowledgeType}]");
        if (items.length > 50) throw badRequest("Bulk limit is 50 items per request.");
        const created = [];
        const errors = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            try {
                const createdItem = knowledge.createKnowledgeItem({
                    businessId: req.xeven.businessId,
                    title: it.title,
                    knowledgeType: it.knowledgeType || it.type || "faq",
                    content: it.content,
                    metadata: it.metadata,
                });
                created.push(createdItem);
            } catch (e) {
                errors.push({ index: i, title: it.title, error: e.message });
            }
        }
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.knowledge.bulk", detail: { created: created.length, errors: errors.length } });
        res.status(201).json({ created, errors, total: created.length });
    } catch (error) {
        next(error);
    }
});

// --- portal chat test — live widget preview without embedding ---
router.post("/chat/test", async (req, res, next) => {
    try {
        // Any authenticated portal user may test their own agent
        if (!req.xeven || !req.xeven.businessId) throw badRequest("Portal authentication required.");
        const body = req.body || {};
        const message = String(body.message || body.content || "").trim();
        if (!message) throw badRequest("Message is required.");
        if (message.length > 4000) throw badRequest("Message too long.");
        const { runChat } = require("../../core/chat/service");
        const customerId = String(body.customerId || "portal_tester").slice(0, 80);
        const conversationId = body.conversationId ? String(body.conversationId).slice(0, 100) : null;
        const messages = Array.isArray(body.messages) && body.messages.length ? body.messages : [{ role: "user", content: message }];
        // If caller sent full history, use it; otherwise single turn
        const result = await runChat({
            businessId: req.xeven.businessId,
            customerInput: { id: customerId },
            messages,
            conversationId,
            channel: "portal_test",
            requestId: req.requestId,
        });
        res.json({ success: true, reply: result.reply, conversationId: result.conversationId, customerId: result.customerId, model: result.model, provider: result.provider });
    } catch (error) {
        next(error);
    }
});

router.put("/knowledge/:id", portal.requireFlag("knowledge_edit"), (req, res, next) => {
    try {
        const updated = knowledge.updateKnowledgeItem(req.xeven.businessId, String(req.params.id), req.body || {});
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.knowledge.updated" });
        res.json({ item: updated });
    } catch (error) {
        next(error);
    }
});

router.delete("/knowledge/:id", portal.requireFlag("knowledge_edit"), (req, res, next) => {
    try {
        knowledge.deleteKnowledgeItem(req.xeven.businessId, String(req.params.id));
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.knowledge.deleted" });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// --- settings ---------------------------------------------------------------

function publicSettings(settings) {
    if (!settings) return {};
    return {
        contactEmail: settings.contact_email || "",
        contactPhone: settings.contact_phone || "",
        businessHours: settings.business_hours || "",
        smtpHost: settings.smtp_host || "",
        smtpPort: settings.smtp_port || 587,
        smtpUser: settings.smtp_user || "",
        smtpFromName: settings.smtp_from_name || "",
        followUpEnabled: Boolean(settings.follow_up_enabled),
        followUpFirstDays: settings.follow_up_first_days,
        followUpMaxAttempts: settings.follow_up_max_attempts,
        followUpIntervalDays: settings.follow_up_interval_days,
    };
}

function applyEditableSettings(businessId, patch) {
    const s = mailer.ensureSettings(businessId);
    const stmt = db().prepare(
        `UPDATE portal_settings SET
            contact_email = COALESCE(?, contact_email),
            contact_phone = COALESCE(?, contact_phone),
            business_hours = COALESCE(?, business_hours),
            smtp_host = COALESCE(?, smtp_host),
            smtp_port = COALESCE(?, smtp_port),
            smtp_user = COALESCE(?, smtp_user),
            smtp_pass_enc = CASE WHEN ? IS NULL THEN smtp_pass_enc ELSE ? END,
            smtp_from_name = COALESCE(?, smtp_from_name),
            follow_up_enabled = COALESCE(?, follow_up_enabled),
            follow_up_first_days = COALESCE(?, follow_up_first_days),
            follow_up_max_attempts = COALESCE(?, follow_up_max_attempts),
            follow_up_interval_days = COALESCE(?, follow_up_interval_days),
            updated_at = ?
         WHERE business_id = ?`
    );

    let passEnc = null;
    if (typeof patch.smtpPassword === "string" && patch.smtpPassword.length > 0) {
        passEnc = crypto.encrypt(patch.smtpPassword);
    }

    stmt.run(
        patch.contactEmail !== undefined ? String(patch.contactEmail).trim().toLowerCase() : null,
        patch.contactPhone !== undefined ? String(patch.contactPhone).trim() : null,
        patch.businessHours !== undefined ? String(patch.businessHours).slice(0, 300) : null,
        patch.smtpHost !== undefined ? String(patch.smtpHost).trim() : null,
        patch.smtpPort !== undefined ? Math.min(65535, Math.max(1, Number(patch.smtpPort) || 587)) : null,
        patch.smtpUser !== undefined ? String(patch.smtpUser).trim() : null,
        passEnc === null ? null : "set",
        passEnc,
        patch.smtpFromName !== undefined ? String(patch.smtpFromName).slice(0, 120) : null,
        patch.followUpEnabled !== undefined ? (patch.followUpEnabled ? 1 : 0) : null,
        patch.followUpFirstDays !== undefined ? Math.min(30, Math.max(0, Number(patch.followUpFirstDays) || 0)) : null,
        patch.followUpMaxAttempts !== undefined ? Math.min(10, Math.max(1, Number(patch.followUpMaxAttempts) || 3)) : null,
        patch.followUpIntervalDays !== undefined ? Math.min(60, Math.max(1, Number(patch.followUpIntervalDays) || 2)) : null,
        Date.now(),
        businessId
    );
}

router.get("/settings", portal.requireFlag("edit_contact"), (req, res) => {
    const settings = publicSettings(mailer.ensureSettings(req.xeven.businessId));
    try {
        const config = configService.getConfig(req.xeven.businessId);
        settings.welcomeMessage = (config.assistant && config.assistant.welcomeMessage) || "";
        settings.tone = (config.assistant && config.assistant.tone) || "";
    } catch {
        settings.welcomeMessage = "";
        settings.tone = "";
    }
    res.json({ settings });
});

router.put("/settings", portal.requireFlag("edit_contact"), (req, res, next) => {
    try {
        applyEditableSettings(req.xeven.businessId, req.body || {});
        // Assistant voice & identity — unified brain (no role constraints)
        if (req.xevenFlags.edit_tone) {
            const patch = { assistant: {} };
            const b = req.body || {};
            const src = b.assistant && typeof b.assistant === "object" ? b.assistant : b;
            if (src.welcomeMessage !== undefined) patch.assistant.welcomeMessage = String(src.welcomeMessage).slice(0, 500);
            if (src.tone !== undefined) patch.assistant.tone = String(src.tone).slice(0, 500);
            if (src.name !== undefined) patch.assistant.name = String(src.name).slice(0, 80);
            // Roles deprecated — unified brain has all 6 patterns, ignore role fields
            if (src.roles !== undefined || src.role !== undefined) {
                patch.assistant.role = "unified";
                patch.assistant.roles = ["unified"];
            }
            if (src.businessDescription !== undefined) patch.assistant.businessDescription = String(src.businessDescription).slice(0, 5000);
            if (src.instructions !== undefined) patch.assistant.instructions = String(src.instructions).slice(0, 5000);
            if (src.personality !== undefined) patch.assistant.personality = String(src.personality).slice(0, 2000);
            if (src.fallbackMessage !== undefined) patch.assistant.fallbackMessage = String(src.fallbackMessage).slice(0, 500);
            if (Object.keys(patch.assistant).length > 0) {
                configService.updateConfig(req.xeven.businessId, patch);
            }
        }
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.settings.updated" });
        const updatedSettings = publicSettings(mailer.ensureSettings(req.xeven.businessId));
        try {
            const cfg = configService.getConfig(req.xeven.businessId);
            updatedSettings.assistant = {
                name: cfg.assistant.name,
                role: "unified",
                roles: ["unified"],
                brain: "unified",
                businessDescription: cfg.assistant.businessDescription,
                instructions: cfg.assistant.instructions,
                personality: cfg.assistant.personality,
                tone: cfg.assistant.tone,
                welcomeMessage: cfg.assistant.welcomeMessage,
                fallbackMessage: cfg.assistant.fallbackMessage,
            };
        } catch {}
        res.json({ settings: updatedSettings });
    } catch (error) {
        next(error);
    }
});

// --- dedicated assistant config route — unified brain (no roles) ---
router.put("/assistant", portal.requireFlag("edit_tone"), (req, res, next) => {
    try {
        const b = req.body || {};
        const src = b.assistant && typeof b.assistant === "object" ? b.assistant : b;
        const patch = { assistant: {} };
        if (src.name !== undefined) patch.assistant.name = String(src.name).slice(0, 80);
        // Roles deprecated — unified brain
        if (src.roles !== undefined || src.role !== undefined) {
            patch.assistant.role = "unified";
            patch.assistant.roles = ["unified"];
        }
        if (src.businessDescription !== undefined) patch.assistant.businessDescription = String(src.businessDescription).slice(0, 5000);
        if (src.instructions !== undefined) patch.assistant.instructions = String(src.instructions).slice(0, 5000);
        if (src.personality !== undefined) patch.assistant.personality = String(src.personality).slice(0, 2000);
        if (src.tone !== undefined) patch.assistant.tone = String(src.tone).slice(0, 500);
        if (src.welcomeMessage !== undefined) patch.assistant.welcomeMessage = String(src.welcomeMessage).slice(0, 500);
        if (src.fallbackMessage !== undefined) patch.assistant.fallbackMessage = String(src.fallbackMessage).slice(0, 500);
        if (Object.keys(patch.assistant).length === 0) throw badRequest("No assistant fields provided.");
        const updated = configService.updateConfig(req.xeven.businessId, patch);
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.assistant.updated" });
        res.json({ assistant: updated.assistant, config: configService.sanitizeConfig(updated) });
    } catch (error) {
        next(error);
    }
});

/** Follow-up policy is its own flag so the founder can allow JUST this. */
router.put("/follow-up-config", portal.requireFlag("edit_followup"), (req, res, next) => {
    try {
        const b = req.body || {};
        applyEditableSettings(req.xeven.businessId, {
            followUpEnabled: b.enabled,
            followUpFirstDays: b.firstDays,
            followUpMaxAttempts: b.maxAttempts,
            followUpIntervalDays: b.intervalDays,
        });
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.followup.configured" });
        const settings = publicSettings(mailer.ensureSettings(req.xeven.businessId));
        res.json({
            enabled: settings.followUpEnabled,
            firstDays: settings.followUpFirstDays,
            maxAttempts: settings.followUpMaxAttempts,
            intervalDays: settings.followUpIntervalDays,
        });
    } catch (error) {
        next(error);
    }
});

/** SMTP connectivity test — sends ONE mail to the business's own address. */
router.post("/settings/test-email", portal.requireFlag("edit_followup"), async (req, res, next) => {
    try {
        const settings = mailer.ensureSettings(req.xeven.businessId);
        if (!settings.contact_email) throw badRequest("Set your contact email first.");
        const result = await mailer.sendAsBusiness(req.xeven.businessId, {
            to: settings.contact_email,
            subject: "XEVEN portal — SMTP test",
            text: "If you received this, your email setup works. XEVEN will send customer follow-ups from this identity.",
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

// --- owner weekly digest (flag: weekly_digest) --------------------------------
// The OWNER may set/change their recipient address, never the capability —
// enabling/disabling stays founder-only (PUT /api/admin/.../digest-config).

router.get("/digest-settings", portal.requireFlag("weekly_digest"), (req, res) => {
    res.json(digests.getConfig(req.xeven.businessId));
});

router.put("/digest-settings", portal.requireFlag("weekly_digest"), async (req, res, next) => {
    try {
        digests.setEmail(req.xeven.businessId, (req.body || {}).email);
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.digest.configured" });
        res.json(digests.getConfig(req.xeven.businessId));
    } catch (error) {
        next(error);
    }
});

// --- read-only views --------------------------------------------------------

router.get("/analytics", portal.requireFlag("view_analytics"), (req, res, next) => {
    try {
        const summary = analytics.summary(req.xeven.businessId);
        const outcomes = require("../../core/outcomes/store").weeklySummary({});
        const mine = outcomes.businesses.find((b) => b.businessId === req.xeven.businessId) || null;
        res.json({ summary, week: mine });
    } catch (error) {
        next(error);
    }
});

router.get("/customers", portal.requireFlag("view_customers"), (req, res) => {
    const result = customers.listCustomers(req.xeven.businessId, { limit: 200 });
    res.json({ customers: result.customers, total: result.total });
});

router.delete("/customers/:id", portal.requireFlag("view_customers"), (req, res, next) => {
    try {
        customers.deleteCustomer(req.xeven.businessId, String(req.params.id));
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.customer.erased" });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

router.get("/conversations", portal.requireFlag("view_analytics"), (req, res) => {
    const result = conversations.listConversations(req.xeven.businessId);
    res.json({ conversations: result.conversations, total: result.total });
});

router.get("/follow-ups", portal.requireFlag("edit_followup"), (req, res) => {
    const rows = db()
        .prepare("SELECT job_uid, customer_id, email, kind, status, attempts, max_attempts, next_send_at, created_at FROM follow_up_jobs WHERE business_id = ? ORDER BY created_at DESC LIMIT 100")
        .all(req.xeven.businessId);
    res.json({ jobs: rows });
});

// ── CHRONO (schedule) — portal-editable availability engine ──
router.get("/chrono/schedule", (req, res, next) => {
    try {
        const sched = require("../../core/chrono/schedule");
        res.json({ schedule: sched.getSchedule(req.xeven.businessId), overrides: sched.listOverrides(req.xeven.businessId) });
    } catch (e) { next(e); }
});
router.put("/chrono/schedule", (req, res, next) => {
    try {
        const sched = require("../../core/chrono/schedule");
        const updated = sched.setSchedule(req.xeven.businessId, req.body || {});
        // also mirror into config.chrono for prompt visibility
        try { configService.updateConfig(req.xeven.businessId, { chrono: req.body || {} }); } catch {}
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.chrono.schedule.updated" });
        res.json({ schedule: updated });
    } catch (e) { next(e); }
});
router.get("/chrono/availability", (req, res, next) => {
    try {
        const { generateAvailability } = require("../../core/chrono/slots");
        const startDate = String(req.query.startDate || req.query.date || "").trim() || undefined;
        const days = Math.min(90, Math.max(1, Number(req.query.days || 30) || 30));
        res.json({ availability: generateAvailability(req.xeven.businessId, { startDate, days, rank: true }) });
    } catch (e) { next(e); }
});
router.post("/chrono/overrides", (req, res, next) => {
    try {
        const sched = require("../../core/chrono/schedule");
        const ov = sched.upsertOverride(req.xeven.businessId, req.body || {});
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.chrono.override.upserted" });
        res.status(201).json({ override: ov });
    } catch (e) { next(e); }
});
router.delete("/chrono/overrides/:id", (req, res, next) => {
    try {
        const sched = require("../../core/chrono/schedule");
        const r = sched.deleteOverride(req.xeven.businessId, String(req.params.id));
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.chrono.override.deleted" });
        res.json(r);
    } catch (e) { next(e); }
});

// ── ADD-ONS — voice_channel + multilanguage attachable via portal ──
router.get("/addons", (req, res, next) => {
    try {
        const store = require("../../core/addons/store");
        res.json({ addons: store.listAddons(req.xeven.businessId) });
    } catch (e) { next(e); }
});
router.put("/addons/:key", (req, res, next) => {
    try {
        const store = require("../../core/addons/store");
        const key = String(req.params.key);
        const body = req.body || {};
        const result = store.setAddon(req.xeven.businessId, key, { enabled: body.enabled, config: body.config });
        // keep cap flags in sync so portal "Capabilities" tab reflects addon state
        const cfgPatch = {};
        if (key === "voice_channel" && body.enabled !== undefined) {
            cfgPatch.features = { capabilities: { "echo.transcribe": Boolean(body.enabled), "call.handoff": Boolean(body.enabled) } };
        }
        if (key === "multilanguage" && body.enabled !== undefined) {
            cfgPatch.features = { ...(cfgPatch.features || {}), capabilities: { ...(cfgPatch.features?.capabilities || {}), "echo.transcribe": Boolean(body.enabled) } };
        }
        if (Object.keys(cfgPatch).length) { try { configService.updateConfig(req.xeven.businessId, cfgPatch); } catch {} }
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.addons.updated", detail: { key, enabled: result.enabled } });
        res.json({ addon: result });
    } catch (e) { next(e); }
});

// ── ECHO / Voice — portal voice settings + calls + transcripts ──
router.get("/voice/settings", (req, res) => {
    const cfg = configService.getConfig(req.xeven.businessId);
    const store = require("../../core/addons/store");
    const echoCfg = store.getAddonConfig(req.xeven.businessId, "voice_channel");
    res.json({
        call: cfg.call,
        echo: cfg.echo,
        voiceAddon: store.listAddons(req.xeven.businessId).find((a) => a.key === "voice_channel"),
        multilanguageAddon: store.listAddons(req.xeven.businessId).find((a) => a.key === "multilanguage"),
        addonConfig: echoCfg,
    });
});
router.put("/voice/settings", (req, res, next) => {
    try {
        const body = req.body || {};
        const patch = { call: {}, echo: {} };
        if (body.greetingTemplate !== undefined) patch.call.greetingTemplate = String(body.greetingTemplate).slice(0, 600);
        if (body.handoffPhone !== undefined) patch.call.handoffPhone = String(body.handoffPhone).slice(0, 40);
        if (body.handoffEmail !== undefined) patch.call.handoffEmail = String(body.handoffEmail).slice(0, 120);
        if (body.defaultLanguage !== undefined) patch.echo.defaultLanguage = String(body.defaultLanguage).slice(0, 10);
        if (body.sidecarUrl !== undefined) patch.echo.sidecarUrl = String(body.sidecarUrl).slice(0, 300);
        if (body.echoEnabled !== undefined) patch.echo.enabled = Boolean(body.echoEnabled);
        if (body.initialPrompt !== undefined) patch.echo.initialPrompt = String(body.initialPrompt).slice(0, 600);
        if (body.wordTimestamps !== undefined) patch.echo.wordTimestamps = Boolean(body.wordTimestamps);
        if (body.ttsModel !== undefined) {
            const m = String(body.ttsModel).trim().toLowerCase();
            if (["piper", "elevenlabs", "openai", "melo"].includes(m)) patch.echo.model = m;
        }
        // remove empty buckets
        if (!Object.keys(patch.call).length) delete patch.call;
        if (!Object.keys(patch.echo).length) delete patch.echo;
        const updated = configService.updateConfig(req.xeven.businessId, patch);
        // mirror voice extra config into addon store as well
        try {
            const store = require("../../core/addons/store");
            if (body.handoffPhone !== undefined || body.greetingTemplate !== undefined) {
                store.setAddon(req.xeven.businessId, "voice_channel", { config: { handoffPhone: patch.call?.handoffPhone, greetingTemplate: patch.call?.greetingTemplate } });
            }
        } catch {}
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.voice.settings.updated" });
        res.json({ call: updated.call, echo: updated.echo });
    } catch (e) { next(e); }
});
router.get("/voice/calls", (req, res, next) => {
    try {
        const calls = require("../../core/echo/calls");
        res.json({ calls: calls.listCalls(req.xeven.businessId, 50) });
    } catch (e) { next(e); }
});
router.get("/voice/transcripts", (req, res, next) => {
    try {
        const rows = db().prepare("SELECT transcript_id, customer_id, conversation_id, language, transcript, duration_ms, created_at FROM echo_transcripts WHERE business_id=? ORDER BY created_at DESC LIMIT 50").all(req.xeven.businessId);
        res.json({ transcripts: rows });
    } catch (e) { next(e); }
});

/** Structured notes for one transcript (summary + action items + points).
 *  Tenant-scoped lookup; resolution never throws (model, else heuristic). */
router.post("/voice/notes", express.json({ limit: "1mb" }), async (req, res, next) => {
    try {
        const id = String((req.body || {}).transcriptId || "").slice(0, 40);
        if (!id) return res.status(400).json({ error: { code: "transcript_required", message: "transcriptId is required." } });
        const row = db().prepare("SELECT transcript, language FROM echo_transcripts WHERE business_id=? AND transcript_id=?").get(req.xeven.businessId, id);
        if (!row) return res.status(404).json({ error: { code: "not_found", message: "Transcript not found." } });
        const { summarizeTranscript } = require("../../core/echo/notes");
        const notes = await summarizeTranscript({ text: row.transcript, language: row.language });
        res.json({ transcriptId: id, notes });
    } catch (e) { next(e); }
});

// ── CUSTOM AGENT BEHAVIOUR BUILDER ──
router.get("/agent-behaviour", (req, res, next) => {
    try {
        const config = configService.getConfig(req.xeven.businessId, { bypassLimit: true });
        const ab = config.agentBehaviour || config.customBehaviour || { enabled: true, rules: [], maxRules: 0, planLimit: 0 };
        const { PLANS } = require("../../core/config/defaults");
        const plan = (configService.getBusiness(req.xeven.businessId)?.plan) || "launch";
        const limits = PLANS[plan]?.limits || PLANS.launch.limits;
        res.json({ agentBehaviour: ab, plan, limits, patterns: require("../../core/agent/brain").PATTERN_IDS });
    } catch (e) { next(e); }
});
router.put("/agent-behaviour", (req, res, next) => {
    try {
        const body = req.body || {};
        const patch = {};
        if (body.rules !== undefined) {
            if (!Array.isArray(body.rules)) throw badRequest("rules must be an array");
            patch.agentBehaviour = { rules: body.rules };
        }
        if (body.enabled !== undefined) {
            patch.agentBehaviour = { ...(patch.agentBehaviour || {}), enabled: Boolean(body.enabled) };
        }
        // also allow {agentBehaviour:{rules:[...]}} wrapper
        if (body.agentBehaviour && typeof body.agentBehaviour === "object") {
            patch.agentBehaviour = { ...(patch.agentBehaviour || {}), ...body.agentBehaviour };
        }
        if (!patch.agentBehaviour || Object.keys(patch.agentBehaviour).length === 0) throw badRequest("No agentBehaviour fields provided");
        const updated = configService.updateConfig(req.xeven.businessId, patch);
        const ab = updated.agentBehaviour || updated.customBehaviour;
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.agent_behaviour.updated", detail: { count: ab.rules?.length || 0 } });
        res.json({ agentBehaviour: ab });
    } catch (e) { next(e); }
});
router.delete("/agent-behaviour/:id", (req, res, next) => {
    try {
        const id = String(req.params.id);
        const config = configService.getConfig(req.xeven.businessId, { bypassLimit: true });
        const ab = config.agentBehaviour || { rules: [] };
        const nextRules = (ab.rules || []).filter(r => String(r.id) !== id);
        const updated = configService.updateConfig(req.xeven.businessId, { agentBehaviour: { rules: nextRules } });
        audit.record({ businessId: req.xeven.businessId, actorType: "portal", actorId: req.xeven.portalUid, action: "portal.agent_behaviour.deleted", detail: { id } });
        res.json({ agentBehaviour: updated.agentBehaviour });
    } catch (e) { next(e); }
});

// ── VOICE CHAT INTEGRATION ──
// POST /api/portal/voice/chat — send transcript to chat pipeline, get reply, optionally speak it
router.post("/voice/chat", async (req, res, next) => {
    try {
        const { runChat } = require("../../core/chat/service");
        const { speak } = require("../../core/echo/tts");
        const body = req.body || {};
        const transcript = String(body.transcript || "").trim();
        if (!transcript) throw badRequest("Transcript is required.");

        const customerId = String(body.customerId || "voice_user").slice(0, 80);
        const conversationId = body.conversationId ? String(body.conversationId).slice(0, 100) : null;
        const speakReply = body.speak !== false; // default true

        const result = await runChat({
            businessId: req.xeven.businessId,
            customerInput: { id: customerId },
            messages: [{ role: "user", content: transcript }],
            conversationId,
            channel: "voice",
            requestId: req.requestId,
        });

        let audioBase64 = null;
        if (speakReply && result.reply) {
            try {
                const cfg = configService.getConfig(req.xeven.businessId);
                const ttsResult = await speak({
                    businessId: req.xeven.businessId,
                    text: result.reply,
                    language: cfg.echo?.defaultLanguage || "en",
                    voice: cfg.echo?.voice || "",
                });
                audioBase64 = ttsResult.audioBase64;
            } catch (e) {
                // TTS failed, continue with text only
            }
        }

        res.json({
            success: true,
            reply: result.reply,
            conversationId: result.conversationId,
            customerId: result.customerId,
            model: result.model,
            provider: result.provider,
            audioBase64,
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
