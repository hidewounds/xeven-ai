"use strict";

const assert = require("node:assert");
const { describe, it, before, after } = require("node:test");
const { startServer, api, setupBusiness } = require("./helpers");

describe("publishable vs secret integration keys", () => {
    let server;
    let setup;
    before(async () => {
        server = await startServer();
        setup = await setupBusiness(server.baseUrl);
    });
    after(async () => server.close());

    it("createBusiness returns split credentials", () => {
        assert.match(setup.integrationKey, /^xeven_pk_sec_[0-9a-f]{64}$/);
    });

    it("publishable key works on widget surface, blocked on management", async () => {
        const created = await api(server.baseUrl, "POST", "/api/admin/businesses", {
            token: setup.adminToken,
            body: { businessName: "Scope Probe" },
        });
        assert.strictEqual(created.status, 201);
        const pub = created.data.widgetPublicKey;
        const sec = created.data.integrationKey;
        assert.match(pub, /^xeven_pk_pub_[0-9a-f]{32}$/);
        assert.match(sec, /^xeven_pk_sec_[0-9a-f]{64}$/);

        const cfg = await api(server.baseUrl, "GET", "/api/v1/widget/config", { key: pub });
        assert.strictEqual(cfg.status, 200);

        const chat = await api(server.baseUrl, "POST", "/api/v1/chat", {
            key: pub,
            body: { customer: { id: "cust-scope" }, messages: [{ role: "user", content: "hi" }] },
        });
        assert.strictEqual(chat.status, 200);

        const ingest = await api(server.baseUrl, "POST", "/api/v1/behavior", {
            key: pub,
            body: { customerId: "cust-scope", eventType: "page_view", eventData: {} },
        });
        assert.ok([200, 201].includes(ingest.status));

        for (const [method, path, body] of [
            ["POST", "/api/v1/knowledge", { title: "t", knowledgeType: "faq", content: "c" }],
            ["GET", "/api/v1/customers/cust-scope", undefined],
            ["GET", "/api/v1/behavior?customerId=cust-scope", undefined],
            ["GET", "/api/v1/analytics/summary", undefined],
            ["PATCH", "/api/v1/business", { businessName: "Hacked" }],
        ]) {
            const r = await api(server.baseUrl, method, path, { key: pub, body });
            assert.strictEqual(r.status, 403, `${method} ${path} should reject publishable key`);
            assert.strictEqual(r.data.error.code, "secret_key_required");
        }

        // secret key keeps full access
        const ok = await api(server.baseUrl, "POST", "/api/v1/knowledge", {
            key: sec,
            body: { title: "t", knowledgeType: "faq", content: "c" },
        });
        assert.strictEqual(ok.status, 201);
    });

    it("rotate-key rotates secret only, publishable stays stable", async () => {
        const created = await api(server.baseUrl, "POST", "/api/admin/businesses", {
            token: setup.adminToken,
            body: { businessName: "Rotate Probe" },
        });
        const oldSec = created.data.integrationKey;
        const pub = created.data.widgetPublicKey;
        const rotated = await api(server.baseUrl, "POST", `/api/admin/businesses/${created.data.business.businessId}/rotate-key`, {
            token: setup.adminToken,
        });
        assert.strictEqual(rotated.status, 200);
        assert.notStrictEqual(rotated.data.integrationKey, oldSec);
        assert.strictEqual(rotated.data.widgetPublicKey, pub);

        const dead = await api(server.baseUrl, "GET", "/api/v1/business", { key: oldSec });
        assert.strictEqual(dead.status, 401);
        const still = await api(server.baseUrl, "GET", "/api/v1/widget/config", { key: pub });
        assert.strictEqual(still.status, 200);
    });
});

describe("admin HttpOnly cookie auth + CSRF", () => {
    let server;
    before(async () => { server = await startServer(); });
    after(async () => server.close());

    it("login sets cookie, /me works without Bearer, logout clears", async () => {
        const email = `cookie-${Date.now()}@test.io`;
        const reg = await fetch(`${server.baseUrl}/api/admin/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: "super-secret-8", name: "Cookie" }),
        });
        assert.strictEqual(reg.status, 201);
        const setCookie = reg.headers.get("set-cookie") || "";
        assert.match(setCookie, /xeven_admin_token=[^;]+;[^]*HttpOnly/);

        const jar = setCookie.split(",").map((c) => c.split(";")[0].trim()).filter((c) => c.startsWith("xeven_admin_")).join("; ");
        const me = await fetch(`${server.baseUrl}/api/admin/auth/me`, { headers: { Cookie: jar } });
        assert.strictEqual(me.status, 200);

        // cookie-authed mutation without CSRF is rejected
        const noCsrf = await fetch(`${server.baseUrl}/api/admin/businesses`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: jar },
            body: JSON.stringify({ businessName: "Nope" }),
        });
        assert.strictEqual(noCsrf.status, 403);

        // with CSRF token it works
        const csrf = await (await fetch(`${server.baseUrl}/api/admin/auth/csrf-token`, { headers: { Cookie: jar } })).json();
        assert.ok(csrf.csrf_token);
        const yesCsrf = await fetch(`${server.baseUrl}/api/admin/businesses`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: jar, "X-CSRF-Token": csrf.csrf_token },
            body: JSON.stringify({ businessName: "Cookie Biz" }),
        });
        assert.strictEqual(yesCsrf.status, 201);

        const out = await fetch(`${server.baseUrl}/api/admin/auth/logout`, { method: "POST", headers: { Cookie: jar } });
        assert.strictEqual(out.status, 200);
        assert.match(out.headers.get("set-cookie") || "", /xeven_admin_token=;/);
    });
});
