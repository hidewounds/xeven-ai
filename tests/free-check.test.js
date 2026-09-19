"use strict";

/**
 * free-check tests: the status reporter runs without keys, network, or a
 * database, always exits 0, prints presence-only key info, and emits a
 * machine-readable final line with the expected shape.
 */

const test = require("node:test");
const assert = require("node:assert");
const { execFile } = require("node:child_process");
const path = require("node:path");

function run() {
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            [path.join(__dirname, "..", "scripts", "free-check.js")],
            { timeout: 30000, env: { ...process.env, VERCEL: "" } },
            (err, stdout, stderr) => {
                if (err) reject(new Error(`free-check exited badly: ${err.message}\n${stdout}\n${stderr}`));
                else resolve(stdout);
            }
        );
    });
}

test("free-check: exits 0 with a machine-readable final line", async () => {
    const out = await run();
    const last = out.trim().split("\n").pop();
    const report = JSON.parse(last);
    assert.strictEqual(report.ok, true);
    const c = report.checks;
    assert.ok(typeof c.provider === "string" && c.provider.length > 0);
    assert.ok(Array.isArray(c.ttsModels) && c.ttsModels.includes("melo"));
    assert.strictEqual(typeof c.meloVoices, "number");
    assert.ok(c.meloVoices >= 5);
    assert.strictEqual(c.notesSelfTest, true);
    assert.ok(c.echoSidecar && typeof c.echoSidecar.available === "boolean");
    assert.ok(c.meloSidecar && typeof c.meloSidecar.available === "boolean");
});

test("free-check: never prints key material", async () => {
    const out = await run();
    assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(out), "no API key may appear in output");
    assert.ok(!/-----BEGIN/.test(out), "no PEM blocks in output");
});
