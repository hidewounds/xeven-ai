"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { startServer, api, setupBusiness } = require("./helpers");

test("config: defaults are applied for a new business", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    const config = await api(server.baseUrl, "GET", "/api/v1/business", { key: setup.integrationKey });
    assert.strictEqual(config.data.config.version, 1);
    // Unified brain — no role switching, one brain with 6 learned patterns
    assert.strictEqual(config.data.config.assistant.role, "unified");
    assert.strictEqual(config.data.config.assistant.brain, "unified");
    assert.ok(Array.isArray(config.data.config.memory.stableFields));
    assert.ok(config.data.config.behavior.events.purchase);
    // Custom behaviour builder defaults
    assert.ok(config.data.config.agentBehaviour);
    assert.strictEqual(Array.isArray(config.data.config.agentBehaviour.rules), true);
});

test("config: patch merges deeply and persists", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    const patched = await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: {
            assistant: { role: "sales", name: "Xeven Sales" },
            context: { maxMemories: 8 },
        },
    });
    assert.strictEqual(patched.status, 200);
    // Unified brain — role is always unified (legacy role fields coerced)
    assert.strictEqual(patched.data.config.assistant.role, "unified");
    assert.strictEqual(patched.data.config.assistant.name, "Xeven Sales");
    assert.strictEqual(patched.data.config.context.maxMemories, 8);
    // untouched defaults survive
    assert.strictEqual(patched.data.config.context.maxBehavior, 10);
});

test("config: unknown sections rejected", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    const response = await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: { hackerSection: { enabled: true } },
    });
    assert.strictEqual(response.status, 400);
});

test("config: secrets never returned by API", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: { model: { provider: "openai-compatible", apiKey: "sk-super-secret-123" } },
    });

    const config = await api(server.baseUrl, "GET", "/api/v1/business", { key: setup.integrationKey });
    assert.strictEqual(config.data.config.model.apiKey, "[configured]");

    // export also sanitized
    const exported = await api(server.baseUrl, "GET", "/api/v1/config/export", { key: setup.integrationKey });
    assert.strictEqual(exported.data.config.model.apiKey, "[configured]");
    assert.notStrictEqual(exported.data.config.model.apiKey, "sk-super-secret-123");
});

test("config: unknown role coerced to unified (unified brain)", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    const patched = await api(server.baseUrl, "PUT", "/api/v1/config", {
        key: setup.integrationKey,
        body: { assistant: { role: "evil_role" } },
    });
    // All roles coerced to unified — one brain has all 6 patterns
    assert.strictEqual(patched.data.config.assistant.role, "unified");
    assert.strictEqual(patched.data.config.assistant.brain, "unified");
});

test("knowledge: CRUD + search scoped to business", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    const created = await api(server.baseUrl, "POST", "/api/v1/knowledge", {
        key: setup.integrationKey,
        body: { title: "Return policy", knowledgeType: "policy", content: "Customers may return items within 30 days." },
    });
    assert.strictEqual(created.status, 201);

    const search = await api(server.baseUrl, "POST", "/api/v1/knowledge/search", {
        key: setup.integrationKey,
        body: { query: "how do returns work?" },
    });
    assert.ok(search.data.items.length >= 1);
    assert.match(search.data.items[0].content, /30 days/);

    const deleted = await api(server.baseUrl, "DELETE", `/api/v1/knowledge/${created.data.item.knowledge_id}`, { key: setup.integrationKey });
    assert.strictEqual(deleted.data.deleted, true);
});
