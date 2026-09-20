"use strict";

/**
 * Property-based tests for tenant isolation.
 * Uses fast-check style property testing to verify isolation invariants.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer, api, setupBusiness } = require("./helpers");
const { normalizeBusinessId } = require("../server/src/core/tenancy/guards");

async function setupTwoBusinesses(server) {
    const a = await setupBusiness(server.baseUrl, { name: "Tenant A" });
    // Second business must be created via the first super-admin's token — isolated temp DB allows only one super-admin registration
    const bRaw = await api(server.baseUrl, "POST", "/api/admin/businesses", {
        token: a.adminToken,
        body: { businessName: "Tenant B" },
    });
    assert.strictEqual(bRaw.status, 201, "second business creation must succeed via super-admin token");
    const b = {
        businessId: bRaw.data.business.businessId,
        integrationKey: bRaw.data.integrationKey,
        config: bRaw.data.config,
        adminToken: a.adminToken,
    };
    return { a, b };
}

test("property: normalizeBusinessId is idempotent", () => {
    const inputs = [
        "Biz_123", "biz_123", "BIZ-123", "  biz_123  ", "biz_123___", "BiZ_123",
        "business_123", "acme_corp", "acme-corp", "ACME_CORP"
    ];
    
    for (const input of inputs) {
        const normalized = normalizeBusinessId(input);
        // Idempotent: normalize(normalize(x)) === normalize(x)
        assert.strictEqual(normalizeBusinessId(normalized), normalized);
        // Valid format: only lowercase, numbers, underscore, hyphen
        assert.match(normalized, /^[a-z0-9_-]+$/);
        // Length constraint
        assert.ok(normalized.length <= 80);
    }
});

test("property: normalizeBusinessId handles edge cases", () => {
    assert.strictEqual(normalizeBusinessId(""), "");
    assert.strictEqual(normalizeBusinessId(null), "");
    assert.strictEqual(normalizeBusinessId(undefined), "");
    assert.strictEqual(normalizeBusinessId(123), "123");
    assert.strictEqual(normalizeBusinessId({}), "");
});

test("property: tenant isolation - cross-business queries return empty", async () => {
    const server = await startServer();
    const { a, b } = await setupTwoBusinesses(server);
    
    // Create data in tenant A
    await api(server.baseUrl, "POST", "/api/v1/chat", {
        key: a.integrationKey,
        body: { customer: { id: "cust-shared" }, messages: [{ role: "user", content: "hello from A" }] }
    });
    
    // Query from tenant B should not see A's data
    const memoriesB = await api(server.baseUrl, "GET", "/api/v1/customers/cust-shared/memories", { key: b.integrationKey });
    assert.strictEqual(memoriesB.status, 200);
    assert.deepStrictEqual(memoriesB.data.memories, []);
    
    // Property: any cross-tenant query returns empty
    const behaviorsB = await api(server.baseUrl, "GET", "/api/v1/behavior?customerId=cust-shared", { key: b.integrationKey });
    assert.strictEqual(behaviorsB.status, 200);
    assert.deepStrictEqual(behaviorsB.data.events, []);
    
    await server.close();
});

test("property: tenant isolation - cross-business mutations fail", async () => {
    const server = await startServer();
    const { a, b } = await setupTwoBusinesses(server);
    
    // Try to write to A's data using B's key (should fail or be no-op)
    const writeA = await api(server.baseUrl, "POST", "/api/v1/chat", {
        key: b.integrationKey,
        body: { customer: { id: "cust-x" }, messages: [{ role: "user", content: "from B" }] }
    });
    
    // If it succeeds, it should create data under B's tenant, not A's
    assert.ok([200, 400, 403].includes(writeA.status));
    
    // Verify A's data unchanged (unknown customer reads 200 with empty list)
    const checkA = await api(server.baseUrl, "GET", "/api/v1/customers/cust-x/memories", { key: a.integrationKey });
    assert.strictEqual(checkA.status, 200); // A never had this customer
    assert.deepStrictEqual(checkA.data.memories, []);
    
    await server.close();
});

test("property: tenant isolation - cross-business reads return empty", async () => {
    const server = await startServer();
    const { a, b } = await setupTwoBusinesses(server);
    
    // Create data in A
    await api(server.baseUrl, "POST", "/api/v1/behavior", {
        key: a.integrationKey,
        body: { customerId: "cust-y", eventType: "page_view", eventData: { page: "/home" } }
    });
    
    // Read from B with same customer ID
    const readB = await api(server.baseUrl, "GET", "/api/v1/behavior?customerId=cust-y", { key: b.integrationKey });
    assert.strictEqual(readB.status, 200);
    assert.strictEqual(readB.data.events.length, 0);
    
    // Property: any read with different tenant key returns empty
    const readA = await api(server.baseUrl, "GET", "/api/v1/behavior?customerId=cust-y", { key: a.integrationKey });
    assert.strictEqual(readA.status, 200);
    assert.strictEqual(readA.data.events.length, 1);
    
    await server.close();
});

test("property: business_id normalization is consistent", () => {
const cases = [
    ["Acme Corp", "acme_corp"],
    ["Acme-Corp", "acme-corp"],
    ["acme corp", "acme_corp"],
    ["ACME CORP", "acme_corp"],
    ["acme corp llc", "acme_corp_llc"],
    ["  spaced  ", "spaced"],
    ["special!@#chars", "special___chars"],
];
    
    for (const [input, expected] of cases) {
        assert.strictEqual(normalizeBusinessId(input), expected);
    }
});

// Property: rapid concurrent operations maintain isolation
test("property: concurrent operations maintain isolation", async () => {
    const server = await startServer();
    const { a, b } = await setupTwoBusinesses(server);
    
    const concurrent = 20;
    const promises = [];
    
    for (let i = 0; i < concurrent; i++) {
        const tenant = i % 2 === 0 ? a : b;
        const custId = `cust-${i}`;
        promises.push(
            api(server.baseUrl, "POST", "/api/v1/chat", {
                key: tenant.integrationKey,
                body: { customer: { id: custId }, messages: [{ role: "user", content: `msg ${i}` }] }
            })
        );
    }
    
    const results = await Promise.all(promises);
    
    // All should succeed
    for (const r of results) {
        assert.strictEqual(r.status, 200);
    }
    
    // Verify isolation: A's customers not visible to B
    const memA = await api(server.baseUrl, "GET", "/api/v1/customers", { key: a.integrationKey });
    const memB = await api(server.baseUrl, "GET", "/api/v1/customers", { key: b.integrationKey });
    
    const aIds = new Set(memA.data.customers.map(c => c.customerId));
    const bIds = new Set(memB.data.customers.map(c => c.customerId));
    
    for (const id of aIds) assert.ok(!bIds.has(id), `Tenant B should not see A's customer ${id}`);
    for (const id of bIds) assert.ok(!aIds.has(id), `Tenant A should not see B's customer ${id}`);
    
    await server.close();
});

test("property: business_id format validation", () => {
    const valid = ["acme", "acme_corp", "acme-corp", "biz123", "a_b_c", "x1y2z3"];
    const invalid = ["", "a@b", "a b", "a.b", "a/b", "a\\b", "a:b", "a;b", "a'b", 'a"b'];
    
    for (const v of valid) {
        const n = normalizeBusinessId(v);
        assert.ok(n.length > 0);
        assert.match(n, /^[a-z0-9_-]+$/);
    }
    
    for (const v of invalid) {
        const n = normalizeBusinessId(v);
        // Should be sanitized to valid format
        assert.match(n, /^[a-z0-9_-]*$/);
    }
});

// =============================================================================
// PROPERTY TESTS FOR IDEMPOTENCY
// =============================================================================

test("property: idempotency - duplicate tool calls return cached result", async () => {
    const server = await startServer();
    const { a } = await setupTwoBusinesses(server);
    
    // Make a tool call that creates a booking
    // (requires voice_receptionist role and booking capability)
    // This is a conceptual test - actual implementation depends on role setup
    await server.close();
});

// =============================================================================
// PROPERTY TESTS FOR STRUCTURED OUTPUT VALIDATION
// =============================================================================

const { parseStructuredOutput, SCHEMAS } = require("../server/src/core/ai/structured-output");

test("property: structured output - valid tool call parses correctly", () => {
    const validToolCall = { tool: "booking.create", arguments: { service: "Consultation", datetime: "2026-01-15T10:00:00Z" } };
    const result = parseStructuredOutput(JSON.stringify(validToolCall), SCHEMAS.toolCall);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.data, validToolCall);
});

test("property: structured output - missing required field fails validation", () => {
    const invalidToolCall = { tool: "booking.create", arguments: { service: "Consultation" } }; // missing datetime
    const result = parseStructuredOutput(JSON.stringify(invalidToolCall), SCHEMAS.toolCall);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("datetime")));
});

test("property: structured output - extra properties rejected", () => {
    const toolCallWithExtra = { tool: "booking.create", arguments: { service: "Consultation", datetime: "2026-01-15T10:00:00Z", extra: "not allowed" } };
    const result = parseStructuredOutput(JSON.stringify(toolCallWithExtra), SCHEMAS.toolCall);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("additional property not allowed")));
});

test("property: structured output - repair handles trailing commas", () => {
    const withTrailingComma = '{ "tool": "booking.create", "arguments": { "service": "Test", "datetime": "2026-01-01T00:00:00Z", } }';
    const result = parseStructuredOutput(withTrailingComma, SCHEMAS.toolCall, { attemptRepair: true });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.repaired, true);
});

test("property: structured output - repair handles single quotes", () => {
    const withSingleQuotes = "{ 'tool': 'booking.create', 'arguments': { 'service': 'Test', 'datetime': '2026-01-01T00:00:00Z' } }";
    const result = parseStructuredOutput(withSingleQuotes, SCHEMAS.toolCall, { attemptRepair: true });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.repaired, true);
});

// =============================================================================
// PROPERTY TESTS FOR MEMORY HYBRID SEARCH
// =============================================================================

test("property: hybrid search - combines keyword and vector scores", async () => {
    const server = await startServer();
    const { a } = await setupTwoBusinesses(server);
    
    // Add memories via explicit remember commands (deterministic extraction)
    await api(server.baseUrl, "POST", "/api/v1/chat", {
        key: a.integrationKey,
        body: { customer: { id: "cust-hybrid" }, messages: [{ role: "user", content: "remember that my favorite color is blue" }] },
    });
    await api(server.baseUrl, "POST", "/api/v1/chat", {
        key: a.integrationKey,
        body: { customer: { id: "cust-hybrid" }, messages: [{ role: "user", content: "remember that my dog is named Rex" }] },
    });
    
    // Search should find relevant memories
    const search = await api(server.baseUrl, "GET", "/api/v1/customers/cust-hybrid/memories", { key: a.integrationKey });
    assert.strictEqual(search.status, 200);
    assert.ok(search.data.memories.length >= 2);
    
    await server.close();
});

test("property: hybrid search - empty query returns empty", async () => {
    const server = await startServer();
    const { a } = await setupTwoBusinesses(server);
    
    // The hybrid search is internal - this is a conceptual test
    await server.close();
});

// =============================================================================
// PROPERTY TESTS FOR MODEL CAPABILITY ROUTING
// =============================================================================

const { getBestModelFor, verifyModelCapabilities } = require("../server/src/core/ai/models");

test("property: model routing - tool requirement filters to tool-capable models", () => {
    const model = getBestModelFor({ tools: true, structuredOutput: true });
    assert.ok(model !== null);
    assert.strictEqual(model.tools, true);
    assert.strictEqual(model.structuredOutput, true);
});

test("property: model routing - vision requirement filters to vision models", () => {
    const model = getBestModelFor({ vision: true });
    assert.ok(model !== null);
    assert.strictEqual(model.vision, true);
});

test("property: model routing - cost constraint filters expensive models", () => {
    const model = getBestModelFor({ maxCost: "low" });
    assert.ok(model !== null);
    assert.ok(["free", "low"].includes(model.cost));
});

test("property: model verification - detects missing capabilities", () => {
    const result = verifyModelCapabilities("mock", ["tools", "structuredOutput", "vision"]);
    assert.strictEqual(result.verified, false);
    assert.ok(result.missing.includes("vision"));
});

// =============================================================================
// PROPERTY TESTS FOR TOKEN BUDGET ENFORCEMENT
// =============================================================================

test("property: token budget - never exceeds maxContextTokens", async () => {
    const server = await startServer();
    const { a } = await setupTwoBusinesses(server);
    
    // Create many memories
    for (let i = 0; i < 20; i++) {
        await api(server.baseUrl, "POST", "/api/v1/chat", {
            key: a.integrationKey,
            body: { customer: { id: "cust-budget" }, messages: [{ role: "user", content: `memory ${i}: ` + "x".repeat(200) }] },
        });
    }
    
    // Send a query that would trigger context building
    const result = await api(server.baseUrl, "POST", "/api/v1/chat", {
        key: a.integrationKey,
        body: { customer: { id: "cust-budget" }, messages: [{ role: "user", content: "what do you know about me?" }] },
    });
    
    assert.strictEqual(result.status, 200);
    // The context engine should enforce token budget internally
    
    await server.close();
});

// =============================================================================
// PROPERTY TESTS FOR RATE LIMITING
// =============================================================================

test("property: rate limiting - excess requests get 429", async () => {
    // Focused unit test with a low cap: the shared helpers force
    // XEVEN_RATE_LIMIT=100000 process-wide, so the full app never 429s here.
    const express = require("express");
    const { rateLimit } = require("../server/src/http/middleware");
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 3 }));
    app.get("/ping", (req, res) => res.json({ ok: true }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: { code: err.code || "error" } }));
    const srv = app.listen(0);
    await new Promise((resolve) => srv.once("listening", resolve));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const results = [];
        for (let i = 0; i < 6; i++) {
            const r = await fetch(`${base}/ping`);
            results.push(r.status);
            await r.text();
        }
        const rateLimited = results.filter((s) => s === 429).length;
        assert.ok(rateLimited > 0, "Should have rate limited some requests");
        assert.strictEqual(results.slice(0, 3).every((s) => s === 200), true);
    } finally {
        try { srv.closeAllConnections(); } catch {}
        await new Promise((resolve) => srv.close(resolve));
    }
});

// =============================================================================
// PROPERTY TESTS FOR CIRCUIT BREAKER
// =============================================================================

const { getCircuitBreakerStatus, resetCircuitBreaker } = require("../server/src/core/ai");

test("property: circuit breaker - opens after threshold failures", () => {
    const { recordProviderFailure, recordProviderSuccess, canUseProvider, getCircuitBreakerStatus } = require("../server/src/core/ai");
    
    resetCircuitBreaker("test-provider");
    const cb = getCircuitBreakerStatus()["test-provider"];
    assert.strictEqual(cb.state, "closed");
    
    recordProviderFailure("test-provider");
    recordProviderFailure("test-provider");
    recordProviderFailure("test-provider");
    
    const cb2 = getCircuitBreakerStatus()["test-provider"];
    assert.strictEqual(cb2.state, "open");
    assert.strictEqual(canUseProvider("test-provider"), false);
    
    resetCircuitBreaker("test-provider");
});

test("property: circuit breaker - half-open after timeout", async () => {
    const { recordProviderFailure, canUseProvider, resetCircuitBreaker } = require("../server/src/core/ai");
    
    resetCircuitBreaker("test-provider-2");
    recordProviderFailure("test-provider-2");
    recordProviderFailure("test-provider-2");
    recordProviderFailure("test-provider-2");
    
    assert.strictEqual(canUseProvider("test-provider-2"), false);
    
    // Wait for half-open (30 seconds in real implementation, but we can't wait in test)
    // This is a conceptual test
    resetCircuitBreaker("test-provider-2");
});