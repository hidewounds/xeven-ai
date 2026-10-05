"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { startServer, api, setupBusiness } = require("./helpers");
const { buildManifest } = require("../server/src/core/bx/manifest");
const shadow = require("../server/src/core/bx/shadow");
const capabilities = require("../server/src/core/capabilities");

// Contract: names mirror bx/bodies/manifests.py XEVEN_MANIFEST verbatim.
const BX_CONTRACT_NAMES = [
    "booking.availability",
    "booking.create",
    "booking.list",
    "call.handoff",
    "chrono.schedule.get",
    "chrono.schedule.set",
    "echo.transcribe",
    "guide.next",
    "guide.start",
    "site.analyze",
];

test("bx: generated manifest matches the BX contract names", () => {
    const names = buildManifest({ businessId: "xeven_web" }).capabilities.map((c) => c.name).sort();
    assert.deepStrictEqual(names, [...BX_CONTRACT_NAMES].sort());
    const byName = Object.fromEntries(buildManifest({}).capabilities.map((c) => [c.name, c]));
    for (const n of ["booking.create", "chrono.schedule.set", "call.handoff"]) {
        assert.strictEqual(byName[n].risk, "write");
        assert.strictEqual(byName[n].requires_confirmation, true);
    }
});

test("bx: think returns null when the brain is unreachable", async () => {
    process.env.BX_BASE_URL = "http://127.0.0.1:9";
    delete require.cache[require.resolve("../server/src/env")];
    delete require.cache[require.resolve("../server/src/core/bx/client")];
    const client = require("../server/src/core/bx/client");
    const t0 = Date.now();
    const decision = await client.think({ userInput: "hi", sessionId: "s" });
    assert.strictEqual(decision, null);
    assert.ok(Date.now() - t0 < 15000, "fallback must be fast");
});

test("bx: shadow is a no-op in native mode", async () => {
    const server = await startServer();
    try {
        const setup = await setupBusiness(server.baseUrl);
        const out = await shadow.runShadow({
            businessId: setup.businessId,
            config: { brain: { mode: "native" } },
            context: { knowledge: [], memories: [], conversation: [] },
            situation: { primary: "general_assistant" },
            lastUserText: "hi",
            conversationId: "conv-x",
        });
        assert.strictEqual(out, null);
        const audit = require("../server/src/core/audit/store");
        const rows = audit.listAudit
            ? audit.listAudit(setup.businessId, { limit: 50 })
            : [];
        assert.ok(!rows.some((r) => String(r.action || "").startsWith("bx.")), "native mode writes no bx audit");
    } finally {
        await server.close();
    }
});

test("bx: shadow logs without acting in shadow mode", async () => {
    const server = await startServer();
    try {
        const setup = await setupBusiness(server.baseUrl);
        const out = await shadow.runShadow({
            businessId: setup.businessId,
            config: { brain: { mode: "shadow" } },
            context: { knowledge: [], memories: [], conversation: [] },
            situation: { primary: "general_assistant" },
            lastUserText: "hi",
            conversationId: "conv-x",
        });
        assert.strictEqual(out, null, "unreachable brain -> null, native continues");
        const audit = require("../server/src/core/audit/store");
        const rows = audit.listAudit(setup.businessId, { limit: 50 });
        const rec = rows.find((r) => r.action === "bx.shadow_decision");
        assert.ok(rec, "shadow decision recorded");
        assert.strictEqual(rec.detail.acted, false);
        assert.ok(rec.detail.unreachable === true || rec.detail.skipped === "unconfigured", "logged without acting");
    } finally {
        await server.close();
    }
});

test("bx: live loop executes the brain tool and voices the result", async () => {
    // Stub brain: canned v1.1 decision proposing booking.availability.
    const stub = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const incoming = JSON.parse(body);
            assert.strictEqual(incoming.protocol, "1.1");
            assert.strictEqual(incoming.body_id, "xeven");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                request_id: incoming.request_id,
                response: "",
                tool_calls: [{ tool: "booking.availability", capability: "booking.availability", arguments: {} }],
                memory_operations: [],
                confidence: 0.9,
                needs_clarification: false,
                escalate: false,
                reason: "availability-check",
                source: "stub",
                protocol: "1.1",
                decision_summary: "check slots",
                provenance: "stub",
                status: "complete",
            }));
        });
    });
    await new Promise((r) => stub.listen(0, r));
    process.env.BX_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
    for (const m of ["../server/src/env", "../server/src/core/bx/client", "../server/src/core/bx/shadow", "../server/src/core/chat/service"]) {
        try { delete require.cache[require.resolve(m)]; } catch {}
    }

    const server = await startServer();
    try {
        const setup = await setupBusiness(server.baseUrl);
        // Flip this business to live bx mode.
        const patched = await api(server.baseUrl, "PATCH", `/api/admin/businesses/${setup.businessId}`, {
            token: setup.adminToken,
            body: { config: { brain: { mode: "bx" } } },
        });
        assert.strictEqual(patched.status, 200);

        const { runChat } = require("../server/src/core/chat/service");
        const out = await runChat({
            businessId: setup.businessId,
            customerInput: { id: "cust-bx" },
            messages: [{ role: "user", content: "when are you free?" }],
            channel: "api",
        });
        assert.ok(out.reply && out.reply.length > 20, "body voiced a real reply");
        assert.ok(!out.reply.includes("{"), "no raw tool JSON leaked to customer");
        const audit = require("../server/src/core/audit/store");
        const rows = audit.listAudit(setup.businessId, { limit: 50 });
        const exec = rows.find((r) => r.action === "bx.tool_executed");
        assert.ok(exec, "bx tool execution traced");
        assert.strictEqual(exec.detail.tool, "booking.availability");
    } finally {
        await new Promise((r) => stub.close(r));
        await server.close();
    }
});
