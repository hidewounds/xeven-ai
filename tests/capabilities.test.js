"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { startServer, api, setupBusiness } = require("./helpers");
const capabilities = require("../server/src/core/capabilities");
const configService = require("../server/src/core/config/service");
const db = require("../server/src/db");
// Unified brain — roles removed, see server/src/core/agent/brain.js
const { LEARNED_PATTERNS } = require("../server/src/core/agent/brain");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function scriptedAI(steps) {
    let i = 0;
    return async ({ messages }) => {
        const step = steps[Math.min(i++, steps.length - 1)];
        const content = typeof step === "function" ? await step({ messages }) : step;
        return { reply: content, model: "scripted", provider: "scripted", usage: { promptTokens: 0, completionTokens: 0 } };
    };
}

function toolBlock(call) {
    return "One moment.\n```json\n" + JSON.stringify(call) + "\n```";
}

/** bookings FK references businesses â€” seed tenants used by direct-handler tests. */
function seedBusiness(businessId) {
    db.get()
        .prepare(
            `INSERT INTO businesses (business_id, business_name, integration_key, active, plan, created_at, updated_at)
             VALUES (?, ?, ?, 1, 'launch', ?, ?)`
        )
        .run(businessId, businessId, `key_${businessId}_${Math.random().toString(36).slice(2)}`, Date.now(), Date.now());
}

/**
 * Future weekday slot at 10:00 UTC. Booking tests rotted on hardcoded
 * September 2026 dates (business hours are Mon-Fri, max 60 days ahead),
 * so slots are computed relative to today instead of frozen in time.
 */
function futureSlot(daysAhead) {
    const d = new Date();
    d.setUTCHours(10, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + daysAhead);
    let guard = 0;
    while ((d.getUTCDay() === 0 || d.getUTCDay() === 6) && guard++ < 10) {
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const SLOT_A = futureSlot(10);
const SLOT_A2 = futureSlot(13); // distinct slot: replaying a token elsewhere must deny
const SLOT_B = futureSlot(11);
const SLOT_C = futureSlot(12);
const SLOT_C_DAY = SLOT_C.slice(0, 10);

// ---------------------------------------------------------------------------
// gate + handlers (direct)
// ---------------------------------------------------------------------------

test("capabilities: role declaration is enforced", async () => {
    db.init();
    try {
        const result = await capabilities.executeCapability({
            businessId: "b_gate",
            customerId: "c1",
            config: {},
            roleDef: { capabilities: ["knowledge.search"] }, // no booking.create
            call: { tool: "booking.create", arguments: { service: "Cut", datetime: "2026-09-03T10:00:00Z" } },
        });
        assert.strictEqual(result.status, "error");
        assert.strictEqual(result.code, "not_declared_for_role");
    } finally {
        db.close();
    }
});

test("capabilities: business toggle disables a tool", async () => {
    db.init();
    try {
        const result = await capabilities.executeCapability({
            businessId: "b_toggle",
            customerId: "c1",
            config: { features: { capabilities: { "booking.availability": false } } },
            roleDef: { capabilities: ["booking.availability", "booking.create", "booking.list"] },
            call: { tool: "booking.availability", arguments: {} },
        });
        assert.strictEqual(result.status, "error");
        assert.strictEqual(result.code, "disabled_by_business");
    } finally {
        db.close();
    }
});

test("booking.availability returns 5 weekdays with open slots", async () => {
    db.init();
    try {
        const result = await capabilities.executeCapability({
            businessId: "biz_avail",
            customerId: "c1",
            config: {},
            roleDef: { capabilities: ["booking.availability"] },
            call: { tool: "booking.availability", arguments: {} },
        });
        assert.strictEqual(result.status, "ok");
        assert.strictEqual(result.data.days.length, 5);
        assert.ok(result.data.days[0].openSlots.includes("09:00"));
        assert.ok(!result.data.days[0].openSlots.includes("17:00")); // closes at 17
    } finally {
        db.close();
    }
});

test("booking.create full write flow: proposal â†’ premature confirm denied â†’ real confirm ok", async () => {
    db.init();
    try {
        seedBusiness("biz_flow");
        const ctx = { businessId: "biz_flow", customerId: "cust_1", conversationId: "conv_flow" };
        const args = { service: "Haircut", datetime: SLOT_A };

        // 1. Proposal without confirmation.
        const proposal = await capabilities.executeCapability({
            ...ctx,
            config: {},
            roleDef: { capabilities: ["booking.create"] },
            call: { tool: "booking.create", arguments: { ...args } },
        });
        assert.strictEqual(proposal.status, "needs_confirmation");
        assert.ok(proposal.token.startsWith("cap_"));

        // 2. Confirm before the customer said anything â†’ denied.
        const premature = await capabilities.executeCapability({
            ...ctx,
            config: {},
            roleDef: { capabilities: ["booking.create"] },
            call: { tool: "booking.create", arguments: { ...args, confirm: true, token: proposal.token } },
        });
        assert.strictEqual(premature.status, "denied");
        assert.match(premature.code, /customer_has_not_replied/);

        // 3. Customer replies (conversation grows), agent re-issues with confirm.
        require("../server/src/db").get()
            .prepare(`INSERT INTO conversation_messages (conversation_id, business_id, customer_id, role, content, created_at)
                      VALUES ('conv_flow', 'biz_flow', 'cust_1', 'user', 'yes please book it', ?)`)
            .run(Date.now());

        const done = await capabilities.executeCapability({
            ...ctx,
            config: {},
            roleDef: { capabilities: ["booking.create"] },
            call: { tool: "booking.create", arguments: { ...args, confirm: true, token: proposal.token } },
        });
        assert.strictEqual(done.status, "ok");
        assert.match(done.data.bookingRef, /^bkg_/);

        // 4. Token replay rejected.
        const replay = await capabilities.executeCapability({
            ...ctx,
            config: {},
            roleDef: { capabilities: ["booking.create"] },
            call: { tool: "booking.create", arguments: { ...args, datetime: SLOT_A2, confirm: true, token: proposal.token } },
        });
        assert.strictEqual(replay.status, "denied");

        // 5. Audit trail recorded.
        const audits = require("../server/src/core/audit/store").listAudit("biz_flow", { limit: 50 });
        assert.ok(audits.some((a) => a.action === "capability.invoke" && a.detail?.status === "ok"));
        assert.ok(audits.some((a) => a.detail?.status === "denied"));
    } finally {
        db.close();
    }
});

test("booking.create rejects bad params and double-bookings", async () => {
    db.init();
    try {
        seedBusiness("biz_double");
        const mk = (args) =>
            capabilities.executeCapability({
                businessId: "biz_double",
                customerId: "c1",
                conversationId: "conv_d",
                config: {},
                roleDef: { capabilities: ["booking.create"] },
                call: { tool: "booking.create", arguments: args },
            });

        const invalid = await mk({ service: "", datetime: "not-a-date" });
        assert.strictEqual(invalid.status, "error");
        assert.strictEqual(invalid.code, "invalid_params");

        // Proper confirm cycle for slot #1.
        const args = { service: "Massage", datetime: SLOT_B };
        const proposal = await mk(args);
        require("../server/src/db").get()
            .prepare(`INSERT INTO conversation_messages (conversation_id, business_id, customer_id, role, content, created_at)
                      VALUES ('conv_d', 'biz_double', 'c1', 'user', 'yes', ?)`)
            .run(Date.now());
        const confirmed = await mk({ ...args, confirm: true, token: proposal.token });
        assert.strictEqual(confirmed.status, "ok");

        // Same slot again â€” a fresh confirmed attempt conflicts at the handler.
        const proposal2 = await mk(args);
        require("../server/src/db").get()
            .prepare(`INSERT INTO conversation_messages (conversation_id, business_id, customer_id, role, content, created_at)
                      VALUES ('conv_d', 'biz_double', 'c1', 'user', 'yes definitely', ?)`)
            .run(Date.now());
        const dupe = await mk({ ...args, confirm: true, token: proposal2.token });
        assert.strictEqual(dupe.status, "error");
        assert.strictEqual(dupe.code, "slot_conflict");
    } finally {
        db.close();
    }
});

test("tenant isolation: bookings never cross businesses", async () => {
    db.init();
    try {
        seedBusiness("tenant_a");
        seedBusiness("tenant_b");
        const theirs = await capabilities.executeCapability({
            businessId: "tenant_a",
            customerId: "shared_cust",
            config: {},
            roleDef: { capabilities: ["booking.list"] },
            call: { tool: "booking.list", arguments: {} },
        });
        const ours = await capabilities.executeCapability({
            businessId: "tenant_b",
            customerId: "shared_cust",
            config: {},
            roleDef: { capabilities: ["booking.list"] },
            call: { tool: "booking.list", arguments: {} },
        });
        assert.strictEqual(theirs.status, "ok");
        assert.strictEqual(ours.status, "ok");
        assert.deepStrictEqual(theirs.data.bookings, ours.data.bookings); // both empty for these tenants
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Unified brain — no role stacking, one brain with 6 learned patterns
// ---------------------------------------------------------------------------

test("unified brain: has learned expertise across 6 patterns, no role constraints", async () => {
    // Unified brain replaces multi-role stacking — one brain has all patterns
    assert.ok(LEARNED_PATTERNS.customer_support);
    assert.ok(LEARNED_PATTERNS.sales);
    assert.ok(LEARNED_PATTERNS.shopping_assistant);
    assert.ok(LEARNED_PATTERNS.product_advisor);
    assert.ok(LEARNED_PATTERNS.lead_qualification);
    assert.ok(LEARNED_PATTERNS.general_assistant);
    assert.strictEqual(Object.keys(LEARNED_PATTERNS).length, 6);
    // Capabilities are business-level, not role-gated — unified brain has all
    const { UNIFIED_CAPABILITIES } = require("../server/src/core/agent/brain");
    assert.ok(UNIFIED_CAPABILITIES.includes("booking.create"));
    assert.ok(UNIFIED_CAPABILITIES.includes("knowledge.search"));
});

test("plans: unified brain — no role limits, all plans have full pattern access", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    // All plans now have unified brain — no role limits to enforce
    // Previously Growth allowed 5 stacked roles, Launch only 1 — now all have full access
    await api(server.baseUrl, "PATCH", `/api/admin/businesses/${setup.businessId}`, {
        token: setup.adminToken,
        body: { plan: "growth" },
    });
    const unified = await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: { assistant: { name: "Test Brain" } }, // no roles needed — unified
    });
    assert.strictEqual(unified.status, 200);
    assert.strictEqual(unified.data.config.assistant.role, "unified");
    assert.deepStrictEqual(unified.data.config.assistant.roles, ["unified"]);

    // Even 6 roles on growth no longer 402 — roles are ignored, unified brain
    const stillOk = await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: {
            assistant: {
                roles: ["sales", "booking_assistant", "product_advisor", "customer_support", "shopping_assistant", "lead_qualification"],
            },
        },
    });
    assert.strictEqual(stillOk.status, 200);
    assert.strictEqual(stillOk.data.config.assistant.role, "unified"); // mapped to unified

    // Downgrade to launch no longer clamps — unified brain on all plans
    await api(server.baseUrl, "PATCH", `/api/admin/businesses/${setup.businessId}`, {
        token: setup.adminToken,
        body: { plan: "launch" },
    });
    const after = await api(server.baseUrl, "GET", "/api/v1/business", { key: setup.integrationKey });
    assert.strictEqual(after.data.config.assistant.role, "unified");
    assert.strictEqual(after.data.business.plan, "launch");

    // Non-super admins still cannot change plans
    const reg2 = await api(server.baseUrl, "POST", "/api/admin/auth/register", {
        token: setup.adminToken,
        body: { email: `a-${Date.now()}@t.io`, password: "super-secret-8", name: "P" },
    });
    assert.strictEqual(reg2.status, 201);
    assert.strictEqual(reg2.data.admin.isSuper, false);
    const denied = await api(server.baseUrl, "PATCH", `/api/admin/businesses/${setup.businessId}`, {
        token: reg2.data.accessToken,
        body: { plan: "unlimited" },
    });
    assert.strictEqual(denied.status, 403);
});

// ---------------------------------------------------------------------------
// end-to-end action loop through runChat (scripted provider)
// ---------------------------------------------------------------------------

test("chat loop executes tools and grounds final answer; write needs two turns", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    await api(server.baseUrl, "PATCH", `/api/admin/businesses/${setup.businessId}`, {
        token: setup.adminToken,
        body: { plan: "growth" },
    });
    await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: { assistant: { role: "booking_assistant" } },
    });

    let capturedToken = null;

    // --- Turn 1: propose booking (needs confirmation).
    const turn1 = await require("../server/src/core/chat/service").runChat({
        businessId: setup.businessId,
        customerInput: { id: "cust_loop" },
        messages: [{ role: "user", content: `Please book a haircut on ${SLOT_C_DAY} at 10:00.` }],
        _ai: scriptedAI([
            ({ messages }) => {
                // Manifest must be present in the system prompt.
                const sys = messages.find((m) => m.role === "system").content;
                assert.ok(sys.includes("AVAILABLE ACTIONS"));
                assert.ok(sys.includes("booking.create"));
                return toolBlock({ tool: "booking.create", arguments: { service: "Haircut", datetime: SLOT_C } });
            },
            ({ messages }) => {
                const resultMsg = messages.filter((m) => m.role === "system" && m.content.includes("[TOOL RESULT]")).pop();
                const outcome = JSON.parse(resultMsg.content.match(/\[TOOL RESULT\] (\{.*\})/)[1]);
                assert.strictEqual(outcome.status, "needs_confirmation");
                capturedToken = outcome.token;
                return `Sure - I can book a Haircut on ${SLOT_C_DAY} at 10:00 UTC. Shall I confirm it?`;
            },
        ]),
    });
    assert.match(turn1.reply, /Shall I confirm/i);
    assert.ok(capturedToken);
    assert.ok(!turn1.reply.includes("```")); // tool blocks stripped from what customers see

    // No booking exists yet.
    let rows = db.get().prepare(`SELECT COUNT(*) AS n FROM bookings WHERE business_id = ?`).get(setup.businessId);
    assert.strictEqual(rows.n, 0);

    // --- Turn 2: customer agrees; agent confirms with the token; slot booked.
    const turn2 = await require("../server/src/core/chat/service").runChat({
        businessId: setup.businessId,
        customerInput: { id: "cust_loop" },
        conversationId: turn1.conversationId,
        messages: [{ role: "user", content: "Yes please, go ahead!" }],
        _ai: scriptedAI([
            () => toolBlock({
                tool: "booking.create",
                arguments: { service: "Haircut", datetime: SLOT_C, confirm: true, token: capturedToken },
            }),
            ({ messages }) => {
                const resultMsg = messages.filter((m) => m.role === "system" && m.content.includes("[TOOL RESULT]")).pop();
                const outcome = JSON.parse(resultMsg.content.match(/\[TOOL RESULT\] (\{.*\})/)[1]);
                assert.strictEqual(outcome.status, "ok");
                return `All set! Your ${outcome.data.service} is confirmed (${outcome.data.bookingRef}).`;
            },
        ]),
    });
    assert.match(turn2.reply, /bkg_/);

    rows = db.get().prepare(`SELECT * FROM bookings WHERE business_id = ?`).all(setup.businessId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].service, "Haircut");
});
