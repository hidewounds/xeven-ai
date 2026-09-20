"use strict";

/**
 * Shared test helpers. Each test file runs in its own Node process
 * (node --test), so setting env vars here gives per-file isolation.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Isolated temp database + forced mock provider + unlimited rate for every test file.
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "mock";
process.env.XEVEN_MOCK_NO_DELAY = "1";
process.env.XEVEN_DB_PATH = path.join(os.tmpdir(), `xeven-test-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.XEVEN_RATE_LIMIT = "100000";
process.env.PORT = "0";

const { createApp } = require("../server/app");
const db = require("../server/src/db");

/** Create an isolated server instance listening on a random port. */
async function startServer() {
    const app = createApp();
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        baseUrl,
        db,
        // NOTE: must destroy keep-alive sockets first — plain server.close()
        // waits for idle connections forever and hangs the test runner.
        // The killer timer guarantees resolution even if close stalls.
        close: () =>
            new Promise((resolve) => {
                let done = false;
                const killer = setTimeout(finish, 3000);
                function finish() {
                    if (done) return;
                    done = true;
                    clearTimeout(killer);
                    try {
                        db.close();
                    } catch {
                        // ignore
                    }
                    try {
                        fs.unlinkSync(process.env.XEVEN_DB_PATH);
                    } catch {
                        // ignore
                    }
                    resolve();
                }
                try {
                    server.closeAllConnections();
                } catch {
                    // older node — fall through to close()
                }
                try {
                    server.close(finish);
                } catch {
                    finish();
                }
            }),
    };
}

async function api(baseUrl, method, urlPath, { key, token, body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["x-xeven-key"] = key;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    let raw = "";
    try {
        raw = await response.text();
        data = JSON.parse(raw);
    } catch {
        // non-JSON (e.g., static JS/HTML) — keep raw, data stays {}
        try { data = JSON.parse(raw); } catch { data = {}; }
    }
    return { status: response.status, data, raw, headers: response.headers };
}

/** Register a super-admin (first account) and create a business. */
async function setupBusiness(baseUrl, { name = "Acme Store" } = {}) {
    const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@test.io`;
    const reg = await api(baseUrl, "POST", "/api/admin/auth/register", {
        body: { email, password: "super-secret-8", name: "Owner" },
    });
    const created = await api(baseUrl, "POST", "/api/admin/businesses", {
        token: reg.data.accessToken,
        body: { businessName: name },
    });
    return {
        adminEmail: email,
        adminToken: reg.data.accessToken,
        businessId: created.data.business.businessId,
        integrationKey: created.data.integrationKey,
        config: created.data.config,
    };
}

module.exports = { startServer, api, setupBusiness };
