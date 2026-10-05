"use strict";

/**
 * BX brain HTTP client. The body calls the brain; the brain never calls back.
 * Any failure (unreachable, timeout, bad shape) resolves to null and the
 * caller runs the native unified brain — the product never depends on BX.
 */

const env = require("../../env");
const { buildManifest } = require("./manifest");

function randomId(prefix) {
    try {
        return `${prefix}_${require("crypto").randomBytes(8).toString("hex")}`;
    } catch {
        return `${prefix}_${Date.now().toString(36)}`;
    }
}

async function think({ userInput, sessionId, context = {}, businessId, timeoutMs } = {}) {
    const baseUrl = String(env.bxBaseUrl || "").replace(/\/+$/, "");
    if (!baseUrl) return null;
    const timeout = timeoutMs || env.bxTimeoutMs || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(`${baseUrl}/v1/think`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                ...(env.bxApiKey ? { Authorization: `Bearer ${env.bxApiKey}` } : {}),
            },
            body: JSON.stringify({
                request_id: randomId("bxr"),
                body_id: "xeven",
                session_id: String(sessionId || "none"),
                user_input: String(userInput || "").slice(0, 20000),
                protocol: "1.1",
                context: {
                    business_name: context.businessName || "",
                    knowledge_snippets: (context.knowledge || []).slice(0, 6).map((k) => `[${k.title || ""}]\n${String(k.content || "").slice(0, 500)}`),
                    memory_facts: (context.memories || []).slice(0, 5).map((m) => `${m.key || m.memory_key || ""}: ${String(m.value || m.memory_value || "").slice(0, 200)}`),
                    conversation: (context.conversation || []).slice(-12),
                },
                available_capabilities: buildManifest({ businessId }).capabilities,
                permissions: {},
                environment: { body_type: "business_ai" },
            }),
        });
        if (!res.ok) return null;
        const decision = await res.json();
        if (!decision || typeof decision !== "object") return null;
        return {
            response: decision.response || "",
            toolCalls: (Array.isArray(decision.tool_calls) ? decision.tool_calls : []).map((t) => ({
                tool: t.tool || t.capability || "",
                arguments: t.arguments && typeof t.arguments === "object" ? t.arguments : {},
            })).filter((t) => t.tool),
            memoryOperations: Array.isArray(decision.memory_operations) ? decision.memory_operations : [],
            confidence: Number(decision.confidence) || 0,
            needsClarification: Boolean(decision.needs_clarification),
            escalate: Boolean(decision.escalate),
            reason: decision.reason || decision.decision_summary || "",
            provenance: decision.provenance || decision.source || "bx",
            protocol: decision.protocol || "1",
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function isConfigured() {
    return Boolean(String(env.bxBaseUrl || "").trim());
}

module.exports = { think, isConfigured };
