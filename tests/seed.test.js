"use strict";

const test = require("node:test");
const assert = require("node:assert");

// Seed flag on for this file only (node --test isolates files per process).
process.env.XEVEN_SEED_ON_BOOT = "1";
process.env.XEVEN_SEED_SECRET_KEY = "xeven_pk_sec_" + "a".repeat(64);
process.env.XEVEN_SEED_PORTAL_PASSWORD = "seed-test-pass-1";
// Isolated temp database (do NOT touch the real local DB).
const os = require("os");
const path = require("path");
const crypto = require("crypto");
process.env.XEVEN_DB_PATH = path.join(os.tmpdir(), "xeven-seedtest-" + crypto.randomBytes(6).toString("hex") + ".db");

const db = require("../server/src/db");

test("seed: fresh database boots the xeven_web business deterministically", () => {
    db.init();
    const biz = db.get().prepare("SELECT business_id, plan, widget_public_key, integration_key FROM businesses").all();
    assert.strictEqual(biz.length, 1);
    assert.strictEqual(biz[0].business_id, "xeven_web");
    assert.strictEqual(biz[0].plan, "unlimited");
    assert.strictEqual(biz[0].widget_public_key, "xeven_pk_pub_2d74e3ed98639ffd4972f702ec338e93");
    assert.strictEqual(biz[0].integration_key, process.env.XEVEN_SEED_SECRET_KEY);
    const n = db.get().prepare("SELECT COUNT(*) n FROM business_knowledge WHERE business_id='xeven_web'").get().n;
    assert.strictEqual(n, 30);
    const portal = db.get().prepare("SELECT email FROM portal_users WHERE business_id='xeven_web'").all();
    assert.strictEqual(portal.length, 1);
    assert.strictEqual(portal[0].email, "portal@xeven.world");
});

test("seed: warm boot never duplicates", () => {
    db.init();
    const n = db.get().prepare("SELECT COUNT(*) n FROM business_knowledge WHERE business_id='xeven_web'").get().n;
    assert.strictEqual(n, 30);
    const b = db.get().prepare("SELECT COUNT(*) n FROM businesses").get().n;
    assert.strictEqual(b, 1);
});
