"use strict";

/**
 * Rebrand compat tests: pre-rebrand embeds keep working.
 * - classifyIntegrationKey maps legacy nova_pk_ forms onto current kinds.
 * - HTTP: an old-prefix key + legacy x-nova-key header authenticates.
 * - Old snippet filenames 301-redirect to the current ones.
 */

const test = require("node:test");
const assert = require("node:assert");
const { classifyIntegrationKey } = require("../server/src/lib/crypto");
const { startServer, api, setupBusiness } = require("./helpers");

test("compat: legacy key prefixes classify like current ones", () => {
    assert.strictEqual(classifyIntegrationKey("nova_pk_" + "a".repeat(64)), "legacy");
    assert.strictEqual(classifyIntegrationKey("xeven_pk_" + "a".repeat(64)), "legacy");
    assert.strictEqual(classifyIntegrationKey("nova_pk_pub_" + "b".repeat(32)), "publishable");
    assert.strictEqual(classifyIntegrationKey("nova_pk_sec_" + "c".repeat(64)), "secret");
    assert.strictEqual(classifyIntegrationKey("garbage"), "unknown");
});

test("compat: legacy key + legacy header authenticate end to end", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const { a } = { a: await setupBusiness(server.baseUrl) };
    const legacyKey = a.integrationKey.replace(/^xeven_pk_/, "nova_pk_");
    assert.ok(legacyKey.startsWith("nova_pk_"), "fixture key converts to legacy form");

    const res = await fetch(`${server.baseUrl}/api/v1/business`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-nova-key": legacyKey },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json().catch(() => ({}));
    assert.ok(data, "legacy auth returns a body");
});

test("compat: old snippet filenames redirect to current ones", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    for (const [oldF, newF] of [
        ["nova-widget.js", "xeven-widget.js"],
        ["nova-tracker.js", "xeven-tracker.js"],
        ["nova-guide.js", "xeven-guide.js"],
    ]) {
        const res = await fetch(`${server.baseUrl}/widget/${oldF}`, { redirect: "manual" });
        assert.strictEqual(res.status, 301);
        assert.ok(String(res.headers.get("location")).endsWith(`/widget/${newF}`));
    }
    const cur = await fetch(`${server.baseUrl}/widget/xeven-widget.js`);
    assert.strictEqual(cur.status, 200);
});
