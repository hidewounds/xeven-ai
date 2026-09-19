"use strict";

/**
 * MeloTTS provider tests (myshell-ai/MeloTTS sidecar integration).
 * Covers: model registry entry, per-language voice lists with EN fallback,
 * params normalization, and the sidecar call contract — success mapping,
 * HTTP errors, and missing audio — with stubbed fetch. No database, no
 * models, no network.
 */

const test = require("node:test");
const assert = require("node:assert");
const tts = require("../server/src/core/echo/tts");

function stubFetch(handler) {
    const prev = globalThis.fetch;
    globalThis.fetch = handler;
    return () => {
        globalThis.fetch = prev;
    };
}

test("melo: registered as a non-streaming multilingual model", () => {
    assert.deepStrictEqual(tts.TTS_MODELS.melo, {
        name: "melo",
        provider: "melo",
        multilingual: true,
        streaming: false,
    });
});

test("melo: voices per language with EN fallback", () => {
    const es = tts.listVoices("melo", "es");
    assert.deepStrictEqual(es, [{ id: "ES", name: "ES", language: "ES" }]);
    const zh = tts.listVoices("melo", "zh");
    assert.ok(zh.some((v) => v.id === "ZH"));
    const unknown = tts.listVoices("melo", "xx");
    assert.ok(unknown.length > 0 && unknown[0].language === "EN");
    const def = tts.listVoices("melo");
    assert.ok(def.some((v) => v.id === "EN-US"));
});

test("melo: params normalize model and clamp speed", () => {
    const p = tts.ttsParams({ model: "MELO", language: "fr", voice: "FR", speed: 9 });
    assert.strictEqual(p.model, "melo");
    assert.strictEqual(p.language, "fr");
    assert.strictEqual(p.speed, 2);
});

test("melo: sidecar success maps audio through", async () => {
    const restore = stubFetch(async (url, opts) => {
        assert.ok(String(url).endsWith("/synthesize"));
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.language, "ES");
        assert.strictEqual(body.speaker_id, "ES");
        return {
            ok: true,
            json: async () => ({ audioBase64: "AAA=", format: "wav", durationMs: 1200, sampleRate: 44100 }),
        };
    });
    try {
        const r = await tts.callMeloSidecar({ sidecarUrl: "http://127.0.0.1:8766", text: "hola", language: "ES", speaker: "ES" });
        assert.strictEqual(r.audioBase64, "AAA=");
        assert.strictEqual(r.format, "wav");
    } finally {
        restore();
    }
});

test("melo: sidecar HTTP error and empty audio both throw", async () => {
    let restore = stubFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
    try {
        await assert.rejects(tts.callMeloSidecar({ sidecarUrl: "http://x:8766", text: "hi" }), /boom/);
    } finally {
        restore();
    }
    restore = stubFetch(async () => ({ ok: true, json: async () => ({ format: "wav" }) }));
    try {
        await assert.rejects(tts.callMeloSidecar({ sidecarUrl: "http://x:8766", text: "hi" }), /no audio/);
    } finally {
        restore();
    }
});

test("melo: missing sidecar URL or text throws before fetch", async () => {
    await assert.rejects(tts.callMeloSidecar({ sidecarUrl: "", text: "hi" }), /required/);
    await assert.rejects(tts.callMeloSidecar({ sidecarUrl: "http://x:8766", text: "  " }), /required/);
});
