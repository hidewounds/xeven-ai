"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { startServer, api, setupBusiness } = require("./helpers");

test("health endpoint is public", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const response = await api(server.baseUrl, "GET", "/api/health");
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.ok, true);
    assert.strictEqual(response.data.service, "XEVEN");
});

test("integration auth: missing key rejected", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const response = await api(server.baseUrl, "GET", "/api/v1/business");
    assert.strictEqual(response.status, 401);
    assert.strictEqual(response.data.error.code, "key_required");
});

test("integration auth: invalid key rejected", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const response = await api(server.baseUrl, "GET", "/api/v1/business", { key: "xeven_pk_bogus" });
    assert.strictEqual(response.status, 401);
});

test("integration auth: bearer authorization also accepted", async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const setup = await setupBusiness(server.baseUrl);

    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${setup.integrationKey}` };
    const response = await fetch(`${server.baseUrl}/api/v1/business`, { headers });
    assert.strictEqual(response.status, 200);
});

test("admin auth: register/login/me flow", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const email = `admin-${Date.now()}@test.io`;
    const registered = await api(server.baseUrl, "POST", "/api/admin/auth/register", {
        body: { email, password: "long-password-1", name: "Admin" },
    });
    assert.strictEqual(registered.status, 201);
    assert.ok(registered.data.accessToken);

    const me = await api(server.baseUrl, "GET", "/api/admin/auth/me", { token: registered.data.accessToken });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.data.admin.email, email);
});

test("admin auth: duplicate registration conflicts", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const body = { email: `dup-${Date.now()}@test.io`, password: "long-password-1" };
    const first = await api(server.baseUrl, "POST", "/api/admin/auth/register", { body });
    assert.strictEqual(first.status, 201);
    // Second attempt with same email must be authenticated as super-admin to reach duplicate check
    const second = await api(server.baseUrl, "POST", "/api/admin/auth/register", { token: first.data.accessToken, body });
    assert.strictEqual(second.status, 409);
});

test("admin auth: wrong password rejected", async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const email = `pw-${Date.now()}@test.io`;
    await api(server.baseUrl, "POST", "/api/admin/auth/register", {
        body: { email, password: "correct-horse" },
    });

    const login = await api(server.baseUrl, "POST", "/api/admin/auth/login", {
        body: { email, password: "wrong-password" },
    });
    assert.strictEqual(login.status, 401);
});
