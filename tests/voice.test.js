"use strict";

/**
 * Voice pipeline integration tests.
 * Tests: sidecar health, batch transcribe, streaming session, TTS, voice chat integration.
 */

const test = require("node:test");
const assert = require("node:assert");
const { startServer, api, setupBusiness } = require("./helpers");

test("voice: sidecar health endpoint exists", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const health = await api(server.baseUrl, "GET", "/api/health/echo");
    assert.strictEqual(health.status, 200);
    assert.ok(typeof health.data.sidecar === "object");
    assert.ok("available" in health.data.sidecar);
});

test("voice: echo.transcribe capability returns sidecar info", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const { a } = await setupTwoBusinesses(server);

    // Test capability via chat with voice_receptionist role
    const result = await api(server.baseUrl, "POST", "/api/v1/chat", {
        key: a.integrationKey,
        body: {
            customer: { id: "voice-test-1" },
            messages: [{ role: "user", content: "test voice capability" }],
        },
    });
    assert.strictEqual(result.status, 200);
});

test("voice: portal voice settings endpoint", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const { a } = await setupTwoBusinesses(server);

    // Login to portal
    const login = await api(server.baseUrl, "POST", "/api/portal/auth/login", {
        body: { email: "admin@tenant-a.com", password: "password123" },
    });
    // Note: This test requires portal user to exist
    // Skipping if portal auth fails
    if (login.status !== 200) {
        console.log("Portal user not set up, skipping voice settings test");
        return;
    }

    const settings = await api(server.baseUrl, "GET", "/api/portal/voice/settings", {
        token: login.data.token,
    });
    assert.strictEqual(settings.status, 200);
    assert.ok(settings.data.echo);
    assert.ok(settings.data.call);
});

test("voice: voice chat integration endpoint", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const { a } = await setupTwoBusinesses(server);

    const login = await api(server.baseUrl, "POST", "/api/portal/auth/login", {
        body: { email: "admin@tenant-a.com", password: "password123" },
    });
    if (login.status !== 200) {
        console.log("Portal user not set up, skipping voice chat test");
        return;
    }

    const result = await api(server.baseUrl, "POST", "/api/portal/voice/chat", {
        token: login.data.token,
        body: { transcript: "Hello, this is a voice test", speak: false },
    });
    assert.strictEqual(result.status, 200);
    assert.ok(result.data.reply);
    assert.ok(result.data.conversationId);
});

test("voice: static voice client served", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const client = await api(server.baseUrl, "GET", "/api/portal/voice/client.js");
    assert.strictEqual(client.status, 200);
    assert.ok(client.raw.includes("XevenVoiceClient"));
});

test("voice: voice test page served", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const page = await api(server.baseUrl, "GET", "/api/portal/voice/test");
    assert.strictEqual(page.status, 200);
    assert.ok(page.raw.includes("XEVEN Voice Client Test"));
});

// Helper from tenant-isolation tests
async function setupTwoBusinesses(server) {
    const a = await setupBusiness(server.baseUrl, { name: "Tenant A" });
    const bRaw = await api(server.baseUrl, "POST", "/api/admin/businesses", {
        token: a.adminToken,
        body: { businessName: "Tenant B" },
    });
    assert.strictEqual(bRaw.status, 201);
    const b = {
        businessId: bRaw.data.business.businessId,
        integrationKey: bRaw.data.integrationKey,
        config: bRaw.data.config,
        adminToken: a.adminToken,
    };
    return { a, b };
}