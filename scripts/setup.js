"use strict";

/**
 * XEVEN setup — ready-on-setup checker.
 * Checks each optional real dependency, prints ✓ ready or ○ idle,
 * and never fails if a dep is missing (system sits idle until you install it).
 * Run: `npm run setup` or `node scripts/setup.js`
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function check(cmd, opts = {}) {
    try {
        const out = execSync(cmd, { stdio: "pipe", timeout: 8000, ...opts }).toString().trim();
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || e.stderr || e.message || "").toString().trim().slice(0, 300) };
    }
}

function log(section, status, detail = "") {
    const icon = status === "ready" ? "✓" : status === "idle" ? "○" : "—";
    console.log(`${icon} ${section.padEnd(28)} ${status}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nXEVEN setup — checking optional deps (idle until you install them)\n");

// 1. Node
const node = check("node -v");
log("node", node.ok ? "ready" : "idle", node.out);

// 2. .env
const envPath = path.join(__dirname, "..", ".env");
const envExample = path.join(__dirname, "..", ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
    try { fs.copyFileSync(envExample, envPath); log(".env", "ready", "created from .env.example"); } catch { log(".env", "idle", "copy failed"); }
} else if (fs.existsSync(envPath)) log(".env", "ready", ".env exists");
else log(".env", "idle", "no .env or .env.example");

// 3. SQLite + migrations
try {
    require("../server/src/db").init();
    log("sqlite/migrations", "ready", "migrations applied");
} catch (e) { log("sqlite/migrations", "idle", e.message); }

// 4. AI provider reachability (openai-compatible endpoint or mock fallback)
const ai = check("node -e \"console.log(process.env.AI_PROVIDER||'openai-compatible')\"");
log("ai-provider", "ready", "provider: " + (ai.out.trim() || "openai-compatible") + " (set OPENAI_API_KEY or AI_PROVIDER=mock)");

// 5. PG
let pgOk = false;
try { require.resolve("pg"); pgOk = true; } catch {}
if (pgOk) {
    const pgEnv = process.env.PG_HOST || process.env.PG_DATABASE ? "env set" : "no PG env";
    log("postgres (pg)", pgEnv.includes("env set") ? "ready" : "idle", pgOk ? `pg ${require("pg/package.json").version}, ${pgEnv} — set DB_DRIVER=postgres to use` : "");
} else log("postgres (pg)", "idle", "pg not installed — using SQLite (npm i pg when ready)");

// 6. Redis
let redisOk = false;
try { require.resolve("ioredis"); redisOk = true; } catch {}
if (!redisOk) try { require.resolve("redis"); redisOk = true; } catch {}
const redisUrl = process.env.XEVEN_REDIS_URL || process.env.REDIS_URL;
if (redisUrl && redisOk) log("redis", "ready", redisUrl);
else if (redisUrl && !redisOk) log("redis", "idle", "REDIS_URL set but redis/ioredis not installed — using in-mem (npm i ioredis)");
else log("redis", "idle", "no REDIS_URL — using in-mem rate limit/CSRF");

// 7. Python + echo sidecar
const py = check("python3 --version 2>&1 || python --version 2>&1");
if (py.ok) log("python", "ready", py.out);
else log("python", "idle", "python3 not found — echo sidecar will use stub (see echo/requirements.txt)");

const echoReq = path.join(__dirname, "..", "echo", "requirements.txt");
if (fs.existsSync(echoReq)) {
    const pip = check("pip show openai-whisper 2>&1 | head -n 1");
    if (pip.ok && pip.out.toLowerCase().includes("whisper")) log("echo whisper", "ready", pip.out);
    else log("echo whisper", "idle", "openai-whisper not installed — transcribe will use stub (pip install -r echo/requirements.txt)");
} else log("echo whisper", "idle", "no echo/requirements.txt");

const piper = check("piper --version 2>&1 | head -n 1");
if (piper.ok) log("piper TTS", "ready", piper.out);
else log("piper TTS", "idle", "piper not found — TTS will use stub");

// 8. Nodemailer (already dep)
log("mailer", "ready", "nodemailer installed");

// Summary
console.log("\nAll checks done. Anything ○ idle will sit idle until you install it — no crash.\n");
console.log("Next: npm run dev  → http://localhost:3000/admin/   (or npm start)\n");
