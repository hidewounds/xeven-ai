"use strict";

/**
 * Deterministic mock provider for tests, CI and offline development.
 * Echoes a structured acknowledgement so pipelines can be verified end to end.
 */

async function chat({ messages, model, baseUrl, apiKey: passedApiKey, temperature, timeoutMs }) {
    // think 1-2s like a human, not instant
    await new Promise(function (r) { setTimeout(r, 1100 + Math.random() * 900); });
    const lastUser = [...(messages || [])].reverse().find(function (m) { return m.role === "user"; });
    const textRaw = lastUser ? String(lastUser.content) : "";
    const text = textRaw.toLowerCase().trim();
    // extract knowledge from system prompt — only the RELEVANT BUSINESS KNOWLEDGE section, not instructions
    const systemMsg = (messages || []).find(function (m) { return m.role === "system"; });
    const fullSystem = systemMsg ? String(systemMsg.content) : "";
    const lowerSystem = fullSystem.toLowerCase();
    const knowledgeStart = lowerSystem.indexOf("relevant business knowledge");
    const knowledgeEnd = knowledgeStart !== -1 ? lowerSystem.indexOf("security rules", knowledgeStart) : -1;
    // knowledge section is between RELEVANT BUSINESS KNOWLEDGE and SECURITY RULES
    let knowledgeSection = "";
    if (knowledgeStart !== -1) {
        const end = knowledgeEnd !== -1 ? knowledgeEnd : fullSystem.length;
        knowledgeSection = fullSystem.slice(knowledgeStart, end);
    }
    // if no knowledge retrieved, the section says "(none retrieved" — not usable, treat as no knowledge
    if (knowledgeSection.toLowerCase().includes("(none retrieved")) knowledgeSection = "";
    function findKnowledge(query) {
        if (!knowledgeSection) return null;
        const qWords = query.toLowerCase().split(/\W+/).filter(function (w) { return w.length > 2; });
        // knowledge entries are formatted as "[Title]\nContent" — split on that pattern
        const entries = knowledgeSection.split(/\n(?=\[)/);
        let best = null, bestScore = 0;
        for (let i = 0; i < entries.length; i++) {
            const b = entries[i].trim();
            if (b.length < 30) continue;
            if (b.toLowerCase().startsWith("relevant business knowledge")) continue;
            if (b.toLowerCase().includes("keep replies short") || b.toLowerCase().includes("learned patterns")) continue;
            let score = 0;
            qWords.forEach(function (w) { if (b.toLowerCase().includes(w)) score++; });
            // also boost if title matches query words
            if (score > bestScore) { bestScore = score; best = b; }
        }
        return bestScore > 0 ? best : null;
    }
    // pure greeting — short, keep attention
    const pureGreeting = text.replace(/[!.,?]+$/g, "").trim();
    const isCrepdog = fullSystem.toLowerCase().includes("crepdog") || knowledgeSection.toLowerCase().includes("crepdog");
    if (/^(hi|hello|hey|hola|howdy|hey there|hi there|hello there|how are you)$/i.test(pureGreeting) || /^(hi|hello|hey) xeven$/i.test(pureGreeting)) {
        return { content: "Hey! How can I help?", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    // navigation has priority — "guide me to features" must navigate, not be treated as generic "features" info
    const guideToMatch = text.match(/guide me to (the )?(\w+)(\s+sections?)?/);
    if (guideToMatch) {
        const target = (guideToMatch[2] || "").toLowerCase();
        const targets = { features: "features.html", pricing: "pricing.html", home: "index.html", checkout: "checkout.html", login: "login.html", feature: "features.html" };
        const page = targets[target] || (target ? target + ".html" : null);
        if (page) {
            return { content: `Opening ${target} for you — taking you there. [NAVIGATE:${page}]`, model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
        }
        return { content: `I can take you to Features, Pricing, or Home — where would you like to go?`, model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.trim() === "guide me" || text.trim() === "guide" || text.includes("show me around") || text.includes("tour guide")) {
        // plain "guide me" without target — don't start overlay here, overlay is only auto on first login
        return { content: "I can take you to Features, Pricing, or Home — just say 'guide me to features'.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    // short human fallbacks — handle common intents before knowledge, keep 1-2 sentences
    if (text.includes("price") || text.includes("pricing") || text.includes("plan") || text.includes("cost")) {
        return { content: "Growth is $79/mo — 10k chats, 200 knowledge items. Launch $29, Scale $199, Custom bespoke. All 14 days free.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    // crepdog-aware: "what does crepdog sell" should return crepdog catalog, not XEVEN generic
    if (isCrepdog && (text.includes("what does crepdog") || text.includes("tell me about crepdog") || text.includes("crepdog crew sell"))) {
        return { content: "Crepdog Crew sells Limited Edition Sneakers & Streetwear — Jordan, Yeezy, Dunks, Apparel, Watches. Mega Drop Sale up to 60% off, instant shipping.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("what do you do") || text.includes("what can you do") || text.includes("tell me about xeven") || (text.includes("features") && !text.includes("guide me to")) || text.includes("sell") || text.includes("what is xeven")) {
        if (isCrepdog) {
            // for Crepdog, don't return XEVEN generic for sell/features, let knowledge handle it
            // fall through to knowledge
        } else {
            return { content: "I'm your AI employee — I answer 24/7 from your site, remember shoppers, and book with Chrono or talk with Echo. One snippet to go live.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
        }
    }
    if (text.includes("install") || text.includes("snippet") || text.includes("paste")) {
        return { content: "Just paste one snippet for widget + tracker — live in a day.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("chrono") || text.includes("book") || text.includes("schedule") || text.includes("slot")) {
        return { content: "Chrono handles bookings — ranked slots, <1s. Set hours in Schedule.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("echo") || text.includes("voice")) {
        return { content: "Echo is voice — widget mic, 100 langs, needs sidecar at 127.0.0.1:8765.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("refund") || text.includes("return") || text.includes("cancel")) {
        if (isCrepdog) {
            return { content: "Crepdog offers COD on Apparel, Instant Shipping on Sneakers. For returns, check policy on site or contact support.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
        }
        return { content: "14 days free, cancel anytime — check pricing.html or I can connect you.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    // shoe handling — business-aware: Crepdog sells shoes, Xeven helps stores sell
    if (text.includes("shoe") || text.includes("shoes") || text.includes("sneaker") || text.includes("sneakers")) {
        if (isCrepdog) {
            if (text.includes("under 10000") || text.includes("under 10k") || text.includes("10000")) {
                return { content: "Yes — Jordan 1 Mid Black Toe from ₹7,999, Mugshot Tees ₹3,990, and more under 10k. Want details on a specific pair?", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
            }
            // for Crepdog, try knowledge first, not generic
            // fall through to knowledge search below
        } else {
            return { content: "We don't sell shoes — we help your store sell them.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
        }
    }
    if (text.includes("product") || text.includes("catalog")) {
        if (!isCrepdog) return { content: "We don't sell shoes — we help your store sell them.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    // try knowledge for anything else — grounded, no hallucination
    const knowledgeSnippetRaw = findKnowledge(text);
    if (knowledgeSnippetRaw) {
        let snippet = knowledgeSnippetRaw.replace(/\s+/g, " ").trim();
        snippet = snippet.replace(/^\[.*?\]\s*/, "").trim().slice(0, 500);
        if (snippet) {
            const sentences = snippet.split(/(?<=[.!?])\s+/).filter(function (s) { return s.trim().length > 15; });
            let relevant = sentences.filter(function (s) {
                return text.split(/\W+/).some(function (w) { return w.length > 3 && s.toLowerCase().includes(w); });
            });
            let answer = (relevant[0] || sentences[0] || snippet).trim();
            answer = answer.replace(/<[^>]+>/g, "").replace(/\[mock\]|\*\*/g, "").replace(/\(authoritative.*$/i, "").trim();
            const shortSentences = answer.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
            answer = shortSentences.length < answer.length ? shortSentences : answer;
            if (answer.length > 260) answer = answer.slice(0, 250).trim() + "…";
            if (answer.length > 20 && !/keep replies short|learned patterns|you have learned expertise/i.test(answer)) {
                if (!/[.!?]$/.test(answer)) answer += ".";
                return { content: answer, model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
            }
        }
    }
    // short human fallbacks for common intents — still grounded, not setlist
    if (text.includes("price") || text.includes("pricing") || text.includes("plan") || text.includes("cost")) {
        return { content: "Growth is $79/mo — 10k chats, 200 knowledge items. Launch $29, Scale $199, Custom bespoke. All 14 days free.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("what do you do") || text.includes("what can you do") || text.includes("features") || text.includes("sell")) {
        return { content: "I help your site answer 24/7, remember shoppers, and book with Chrono or talk with Echo. One snippet to go live.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("install") || text.includes("snippet") || text.includes("paste")) {
        return { content: "Just paste one snippet for widget + tracker — live in a day.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("chrono") || text.includes("book") || text.includes("schedule") || text.includes("slot")) {
        return { content: "Chrono handles bookings — ranked slots, <1s. Set hours in Schedule.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("echo") || text.includes("voice")) {
        return { content: "Echo is voice — widget mic, 100 langs, needs sidecar at 127.0.0.1:8765.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("guide") || text.includes("tour") || text.includes("show me")) {
        return { content: "Say 'guide me' and I'll highlight your site step by step.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("refund") || text.includes("return") || text.includes("cancel")) {
        if (isCrepdog) {
            return { content: "Crepdog offers COD on Apparel, Instant Shipping on Sneakers. For returns, check policy on site or contact support.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
        }
        return { content: "14 days free, cancel anytime — check pricing.html or I can connect you.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
    }
    if (text.includes("shoe") || text.includes("shoes") || text.includes("sneaker") || text.includes("sneakers")) {
        if (isCrepdog) {
            // for Crepdog, let knowledge handle it — fall through
        } else {
            return { content: "We don't sell shoes — we help your store sell them.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
        }
    }
    // handoff to ChatGPT for anything else — simple human, no overcomplication, keep 1-2 short sentences
    const env = require("../../env");
    const apiKey = passedApiKey || env.ai.openaiApiKey || env.OPENAI_API_KEY;
    const base = baseUrl || env.ai.openaiBaseUrl || "https://api.openai.com/v1";
    const mdl = model || env.ai.model || "gpt-4o-mini";
    if (apiKey && base) {
        try {
            const openAIProvider = require("./openai-provider");
            const simpleMessages = [
                { role: "system", content: "You are Xeven for XEVEN website. Reply in 1-2 short, simple human sentences (max 30 words). No lists, no jargon, no hallucination — only use provided knowledge. Be warm and concise." },
                ...messages.slice(-4),
            ];
            const r = await openAIProvider.chat({ messages: simpleMessages, model: mdl, baseUrl: base, apiKey, temperature: 0.7, timeoutMs: timeoutMs || 8000 });
            let content = String(r.content || "").trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
            if (content.length > 240) content = content.slice(0, 230) + "…";
            return { content, model: r.model || mdl, usage: r.usage || { promptTokens: 0, completionTokens: 0 } };
        } catch (e) {}
    }
    return { content: "Happy to help — ask me about pricing, features, install or booking and I'll keep it short.", model: "mock", usage: { promptTokens: 0, completionTokens: 0 } };
}

module.exports = { name: "mock", chat };
