"use strict";

/**
 * Self-healing production seed (durability fix for ephemeral /tmp SQLite).
 *
 * When XEVEN_SEED_ON_BOOT=1, each boot ensures the baseline exists:
 * - businesses table EMPTY  -> recreate xeven_web with DETERMINISTIC
 *   credentials + full knowledge base (widget snippet keeps working).
 * - admin_users table EMPTY and XEVEN_SEED_ADMIN_EMAIL/PASSWORD set ->
 *   recreate that account (first account = super-admin), so the owner login
 *   survives wipes with zero human intervention.
 *
 * Safety rules:
 * - NEVER touches existing rows (warm instance: no-op per table).
 * - NEVER runs in tests (helpers do not set the flag) or on postgres.
 * - NEVER logs secrets (email local-part only).
 * - Public key defaults to the key embedded in the live xeven-web snippet.
 *   Override with XEVEN_SEED_PUBLIC_KEY (must match xeven_pk_pub_<32hex>).
 * - Secret comes from XEVEN_SEED_SECRET_KEY (xeven_pk_sec_<64hex>). If unset,
 *   a random one is issued and only its prefix is logged; set the env var in
 *   Vercel for a stable secret across wipes.
 * - Portal user recreated only if XEVEN_SEED_PORTAL_PASSWORD is set.
 */

const fs = require("fs");
const path = require("path");

const SEED_FLAG = process.env.XEVEN_SEED_ON_BOOT === "1";
const DEFAULT_PUBLIC_KEY = "xeven_pk_pub_2d74e3ed98639ffd4972f702ec338e93";
const PORTAL_EMAIL = "portal@xeven.world";

function seedAllowed() {
    if (!SEED_FLAG) return false;
    if (String(process.env.DB_DRIVER || "").toLowerCase() === "postgres") return false;
    return true;
}

function tableCount(table) {
    try {
        const db = require("./index").get();
        const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
        return row ? row.n : -1;
    } catch {
        return -1;
    }
}

function seedBusiness() {
    if (tableCount("businesses") !== 0) return { seeded: false };
    const db = require("./index").get();
    const configService = require("../core/config/service");
    const { createKnowledgeItem } = require("../core/knowledge/store");
    const crypto = require("../lib/crypto");

    const pubKey = String(process.env.XEVEN_SEED_PUBLIC_KEY || DEFAULT_PUBLIC_KEY).trim();
    if (!/^xeven_pk_pub_[0-9a-f]{32}$/.test(pubKey)) {
        throw new Error("XEVEN_SEED_PUBLIC_KEY must look like xeven_pk_pub_<32hex>.");
    }
    let secret = String(process.env.XEVEN_SEED_SECRET_KEY || "").trim();
    let secretGenerated = false;
    if (!/^xeven_pk_sec_[0-9a-f]{64}$/.test(secret)) {
        secret = crypto.generateSecretKey();
        secretGenerated = true;
    }

    configService.createBusiness({ businessId: "xeven_web", businessName: "Xeven" });
    configService.setBusinessPlan("xeven_web", "unlimited");
    db.prepare("UPDATE businesses SET integration_key = ?, widget_public_key = ? WHERE business_id = 'xeven_web'")
        .run(secret, pubKey);

    const items = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-knowledge.json"), "utf8"));
    let added = 0;
    for (const item of items) {
        createKnowledgeItem({ businessId: "xeven_web", title: item.title, knowledgeType: item.knowledgeType, content: item.content });
        added++;
    }

    let portal = null;
    const portalPass = String(process.env.XEVEN_SEED_PORTAL_PASSWORD || "");
    if (portalPass.length >= 8) {
        const portalAuth = require("../auth/portal");
        portal = portalAuth.registerPortalUser({ businessId: "xeven_web", email: PORTAL_EMAIL, password: portalPass });
    }

    console.log(`[seed] recreated xeven_web: plan=unlimited knowledge=${added} publicKey=${pubKey} portal=${portal ? PORTAL_EMAIL : "skipped"}`);
    if (secretGenerated) {
        console.log(`[seed] ephemeral secret issued (set XEVEN_SEED_SECRET_KEY for stability): ${secret.slice(0, 18)}...`);
    }
    return { seeded: true, knowledge: added, portal: Boolean(portal), secretGenerated };
}

function seedAdmin() {
    if (tableCount("admin_users") !== 0) return { seeded: false };
    const email = String(process.env.XEVEN_SEED_ADMIN_EMAIL || "").trim().toLowerCase();
    const password = String(process.env.XEVEN_SEED_ADMIN_PASSWORD || "");
    if (!email || password.length < 8) return { seeded: false, reason: "no-credentials" };
    const adminAuth = require("../auth/admin");
    const created = adminAuth.registerAdmin({ email, password });
    const masked = email.replace(/^(.).*(@.*)$/, "$1***$2");
    console.log(`[seed] recreated admin ${masked} super=${created.admin.isSuper}`);
    return { seeded: true, super: created.admin.isSuper };
}

function maybeSeed() {
    if (!seedAllowed()) return { seeded: false };
    const business = seedBusiness();
    const admin = seedAdmin();
    return { seeded: business.seeded || admin.seeded, business, admin };
}

function shouldSeed() {
    return seedAllowed() && (tableCount("businesses") === 0 || tableCount("admin_users") === 0);
}

module.exports = { maybeSeed, shouldSeed };
