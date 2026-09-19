"use strict";

/**
 * Echo notes tests: structured meeting notes from transcripts.
 * Covers the empty path, the deterministic heuristic, the tolerant JSON
 * parser, and the full summarizeTranscript() flow against the forced mock
 * provider (which cannot return notes JSON, so the heuristic must win).
 */

const test = require("node:test");
const assert = require("node:assert");
const { extractiveNotes, parseNotesJson, summarizeTranscript } = require("../server/src/core/echo/notes");

test("notes: empty transcript resolves empty without a provider call", async () => {
    for (const text of ["", "   ", null, undefined]) {
        const r = await summarizeTranscript({ text });
        assert.deepStrictEqual(r, { summary: "", actionItems: [], keyPoints: [], source: "empty" });
    }
});

test("notes: heuristic finds commitments and leads with the opening", () => {
    const text =
        "Kickoff call with Acme Store about the holiday launch. " +
        "Priya will send the product feed by Friday. " +
        "We discussed the winter palette at length and agreed it feels premium. " +
        "Please review the demo script before Thursday.";
    const r = extractiveNotes(text);
    assert.strictEqual(r.source, "heuristic");
    assert.ok(r.summary.startsWith("Kickoff call"), "summary leads with the opening");
    assert.strictEqual(r.actionItems.length, 2);
    assert.ok(r.actionItems.some((s) => s.includes("Priya will send")));
    assert.ok(r.actionItems.some((s) => s.includes("review the demo script")));
    assert.ok(r.keyPoints.some((s) => s.includes("winter palette")));
});

test("notes: heuristic caps items and never duplicates", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Please confirm item number ${i} with the team.`).join(" ");
    const r = extractiveNotes(text);
    assert.ok(r.actionItems.length <= 8);
    assert.strictEqual(new Set(r.actionItems).size, r.actionItems.length);
});

test("notes: parseNotesJson tolerates fences and rejects garbage", () => {
    const fenced = '```json\n{"summary": "S", "actionItems": ["a"], "keyPoints": []}\n```';
    assert.deepStrictEqual(parseNotesJson(fenced), { summary: "S", actionItems: ["a"], keyPoints: [] });
    assert.strictEqual(parseNotesJson("just some prose"), null);
    assert.strictEqual(parseNotesJson('{"nope": true}'), null);
    assert.strictEqual(parseNotesJson(null), null);
    const capped = parseNotesJson(JSON.stringify({ summary: "", actionItems: Array.from({ length: 30 }, (_, i) => `x${i}`), keyPoints: [] }));
    assert.strictEqual(capped.actionItems.length, 8);
});

test("notes: summarizeTranscript falls back to heuristic on mock provider", async () => {
    const text =
        "Support call with Marco. The widget answered billing questions all week. " +
        "Marco should upgrade to Growth before the sale ends. " +
        "We will schedule onboarding for Tuesday morning.";
    const r = await summarizeTranscript({ text });
    assert.strictEqual(r.source, "heuristic");
    assert.ok(r.summary.length > 0);
    assert.ok(r.actionItems.length >= 2);
    assert.ok(Array.isArray(r.keyPoints));
});

test("notes: long transcripts are truncated, never throw", async () => {
    const text = "Weekly sync. ".repeat(2000) + " Priya will send the notes.";
    const r = await summarizeTranscript({ text });
    assert.strictEqual(r.source, "heuristic");
    assert.ok(r.summary.length > 0);
});
