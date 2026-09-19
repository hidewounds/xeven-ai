"use strict";

/**
 * ECHO notes — structured meeting notes from call transcripts.
 * Inspired by local-first meeting assistants (Meetily): every voice call
 * should end with a summary, action items, and key points — without
 * shipping audio anywhere new. Runs through the existing AI provider
 * abstraction; any failure (including the mock provider's non-JSON echo
 * in tests) falls back to a deterministic extractive pass, so notes are
 * always well-shaped and never invented beyond the transcript.
 */

const ai = require("../ai");

const MAX_INPUT_CHARS = 6000;
const MAX_ITEMS = 8;

function splitSentences(text) {
    return String(text || "")
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim().replace(/\s+/g, " "))
        .filter((s) => s.length > 1);
}

const ACTION_PATTERNS = [
    /^(please\s+)?(send|email|call|schedule|book|prepare|review|share|update|fix|check|confirm|draft|create|add|remind)\b/i,
    /\bfollow[\s-]?up\b/i,
    /\b(will|need to|needs to|should|must|has to|have to|going to|let's|lets)\b/i,
    /\b(action item|to-?do|next steps?)\b/i,
];

function isAction(sentence) {
    return ACTION_PATTERNS.some((re) => re.test(sentence));
}

/**
 * Deterministic extractive pass. No model involved: summary is the lead,
 * action items match commitment language, key points are the remaining
 * substantive sentences. Pure function — trivially testable.
 */
function extractiveNotes(text) {
    const sents = splitSentences(text).slice(0, 40);
    const summary = sents.slice(0, 2).join(" ");
    const actionItems = [];
    const keyPoints = [];
    for (const s of sents) {
        if (isAction(s)) {
            if (actionItems.length < MAX_ITEMS && !actionItems.includes(s)) actionItems.push(s);
        } else if (keyPoints.length < 5 && s.length >= 24 && !keyPoints.includes(s)) {
            keyPoints.push(s);
        }
    }
    return { summary, actionItems, keyPoints, source: "heuristic" };
}

/**
 * Tolerantly parse model output into notes shape. Returns null when the
 * content is not usable notes JSON (wrong shape, unparseable) so the
 * caller can fall back instead of surfacing garbage.
 */
function parseNotesJson(raw) {
    if (typeof raw !== "string") return null;
    const stripped = raw.replace(/```(?:json)?/gi, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    let obj;
    try {
        obj = JSON.parse(stripped.slice(start, end + 1));
    } catch {
        return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const arr = (v) =>
        Array.isArray(v)
            ? v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, MAX_ITEMS)
            : [];
    if (!str(obj.summary) && arr(obj.actionItems).length === 0 && arr(obj.keyPoints).length === 0) return null;
    return { summary: str(obj.summary), actionItems: arr(obj.actionItems), keyPoints: arr(obj.keyPoints) };
}

/**
 * Transcript -> { summary, actionItems[], keyPoints[], source }.
 * source is 'empty' | 'model' | 'heuristic'. Never throws for bad input;
 * model errors degrade to the extractive pass (verified-or-silent applies
 * to customer answers, but internal notes must always resolve).
 */
async function summarizeTranscript({ text, language, modelConfig } = {}) {
    const clean = String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_INPUT_CHARS);
    if (!clean) return { summary: "", actionItems: [], keyPoints: [], source: "empty" };
    const prompt =
        'Turn this call transcript into notes. Reply with JSON ONLY in exactly this shape: {"summary": "2 sentences max", "actionItems": ["..."], "keyPoints": ["..."]}. ' +
        "List every commitment as an action item. If none, use empty arrays." +
        (language ? ` Transcript language: ${language}.` : "") +
        `\nTranscript:\n${clean}`;
    try {
        const res = await ai.generate({
            messages: [
                { role: "system", content: "You turn call transcripts into structured notes. Reply with JSON only." },
                { role: "user", content: prompt },
            ],
            modelConfig: modelConfig || {},
        });
        const parsed = parseNotesJson(res && res.content);
        if (parsed) return { ...parsed, source: "model" };
    } catch {
        // fall through to heuristic
    }
    return extractiveNotes(clean);
}

module.exports = {
    MAX_INPUT_CHARS,
    MAX_ITEMS,
    splitSentences,
    extractiveNotes,
    parseNotesJson,
    summarizeTranscript,
};
