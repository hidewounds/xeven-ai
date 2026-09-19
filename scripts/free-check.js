"use strict";

/**
 * Free-mode status reporter. Prints what runs at $0 right now without
 * spending anything: provider config, sidecar reachability (short
 * timeouts, failures are data), TTS registry, and a notes-heuristic
 * self-test. Key material is never printed — presence only.
 * Run: `node scripts/free-check.js` (exit 0 always; machine line last).
 */

const env = require("../server/src/env");
const { checkSidecarHealth } = require("../server/src/core/echo/transcribe");
const tts = require("../server/src/core/echo/tts");
const { extractiveNotes } = require("../server/src/core/echo/notes");

function present(v) {
    const s = String(v || "").trim();
    return s.length > 0 && !s.includes("...") && !/placeholder|changeme|example/i.test(s);
}

async function meloHealth(url) {
    if (!url || !String(url).trim()) return { available: false, reason: "no_url" };
    if (/127\.0\.0\.1|localhost/.test(String(url)) && process.env.VERCEL) {
        return { available: false, reason: "serverless_no_localhost" };
    }
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${String(url).replace(/\/$/, "")}/health`, { signal: controller.signal });
        clearTimeout(t);
        return { available: res.ok };
    } catch (e) {
        return { available: false, error: String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 80) };
    }
}

async function main() {
    const openaiKey = (env.ai.openaiApiKey || process.env.OPENAI_API_KEY || "").trim();
    const notes = extractiveNotes("Kickoff call. Priya will send the feed Friday. Budget approved.");
    const report = {
        ok: true,
        provider: env.ai.provider || "mock",
        database: String(env.dbPath || process.env.XEVEN_DB_PATH || "default").split(/[\\/]/).pop(),
        openaiKey: openaiKey.startsWith("sk-") && openaiKey.length > 20 && !openaiKey.includes("..."),
        elevenlabsKey: present(process.env.ELEVENLABS_API_KEY),
        hfToken: present(env.hfToken),
        echoSidecar: await checkSidecarHealth(env.echoSidecarUrl),
        meloSidecar: await meloHealth(env.meloSidecarUrl),
        ttsModels: Object.keys(tts.TTS_MODELS),
        meloVoices: tts.listVoices("melo", "en").length + tts.listVoices("melo", "es").length,
        notesSelfTest:
            notes.source === "heuristic" &&
            notes.summary.length > 0 &&
            notes.actionItems.some((s) => s.includes("Priya will send")),
    };
    console.log("xeven free-mode status (keys shown as presence only):");
    console.log(`- provider: ${report.provider} · database: ${report.database}`);
    console.log(`- openai key: ${report.openaiKey ? "set" : "missing"} · elevenlabs: ${report.elevenlabsKey ? "set" : "missing"} · hf: ${report.hfToken ? "set" : "missing"}`);
    console.log(`- echo sidecar: ${JSON.stringify(report.echoSidecar)}`);
    console.log(`- melo sidecar: ${JSON.stringify(report.meloSidecar)}`);
    console.log(`- tts models: ${report.ttsModels.join(",")} · melo voices(en+es): ${report.meloVoices}`);
    console.log(`- notes heuristic self-test: ${report.notesSelfTest ? "pass" : "FAIL"}`);
    console.log(JSON.stringify({ ok: true, checks: report }));
}

if (require.main === module) {
    main().catch((e) => {
        console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
        process.exitCode = 1;
    });
}

module.exports = { main };
