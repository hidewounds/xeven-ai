"use strict";

/**
 * Phase 0 shadow: ask the BX brain what it would do, log the decision next to
 * the native one, never act on it. Powers the eval baseline for Phase 1.
 * Zero-ops when brain mode is "native" or BX is unconfigured/unreachable.
 */

const audit = require("../audit/store");
const client = require("./client");

function brainMode(config) {
    const mode = config && config.brain && config.brain.mode;
    return mode === "bx" || mode === "shadow" ? mode : "native";
}

function agreementScore(decision, situation) {
    try {
        const firstTool = (decision.toolCalls[0] || {}).tool || "";
        const primary = (situation && situation.primary) || "";
        if (!firstTool) return decision.escalate || decision.needsClarification ? "no-action" : "abstain";
        const tool = firstTool.toLowerCase();
        if (primary === "general_assistant" && /booking|chrono/.test(tool)) return "agree";
        if (primary === "customer_support" && /handoff|guide|knowledge/.test(tool)) return "agree";
        if (primary === "sales" && /knowledge|guide/.test(tool)) return "agree";
        if (primary === "shopping_assistant" && /knowledge|guide/.test(tool)) return "agree";
        if (primary === "product_advisor" && /knowledge|guide|site/.test(tool)) return "agree";
        if (primary === "lead_qualification" && (tool === "" || /knowledge/.test(tool))) return "agree";
        return "diverge";
    } catch {
        return "unknown";
    }
}

async function runShadow({ businessId, config, context, situation, lastUserText, conversationId }) {
    const mode = brainMode(config);
    if (mode === "native") return null;
    if (!client.isConfigured()) {
        recordShadow(businessId, { mode, acted: false, skipped: "unconfigured", nativePrimary: (situation && situation.primary) || null });
        return null;
    }
    const decision = await client.think({
        userInput: lastUserText,
        sessionId: conversationId || "none",
        context: {
            businessName: context.businessName,
            knowledge: context.knowledge,
            memories: context.memories,
            conversation: context.conversation,
        },
        businessId,
    });
    const record = decision
        ? {
            mode,
            acted: false,
            confidence: decision.confidence,
            provenance: decision.provenance,
            protocol: decision.protocol,
            toolCalls: decision.toolCalls.map((t) => ({ tool: t.tool, arguments: t.arguments })),
            escalate: decision.escalate,
            needsClarification: decision.needsClarification,
            nativePrimary: (situation && situation.primary) || null,
            agreement: agreementScore(decision, situation),
        }
        : { mode, acted: false, unreachable: true, nativePrimary: (situation && situation.primary) || null };
    try {
        audit.record({
            businessId,
            actorType: "system",
            actorId: "bx-shadow",
            action: mode === "bx" ? "bx.decision" : "bx.shadow_decision",
            detail: record,
        });
    } catch {
        // audit never blocks chat
    }
    return decision;
}

function recordShadow(businessId, detail) {
    try {
        audit.record({ businessId, actorType: "system", actorId: "bx-shadow", action: "bx.shadow_decision", detail });
    } catch {
        // audit never blocks chat
    }
}

module.exports = { runShadow, brainMode, agreementScore };
