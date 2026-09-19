"use strict";

/**
 * Content sanitization for prompt injection defense.
 * Sanitizes knowledge, behavior, tool outputs before prompt injection.
 */

const { createLogger } = require("../lib/logger");

const log = createLogger({ component: "sanitize" });

// System prompt fingerprints that should never appear in model output
const SYSTEM_PROMPT_FINGERPRINTS = [
    "operating on behalf of a business",
    "security rules",
    "available actions",
    "stacked skills",
    "[tool result]",
    "business instructions",
    "guidelines:",
    "factual grounding",
    "you are xeven",
    "as an ai assistant",
    "your role is",
    "you must not",
    "you should not",
    "never reveal",
    "do not disclose",
];

// Injection patterns that may appear in retrieved content
const INJECTION_PATTERNS = [
    /ignore\s+(?:all\s+)?(?:previous\s+)?instructions?/i,
    /system\s+prompt/i,
    /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i,
    /override\s+(?:all\s+)?(?:rules?|instructions?)/i,
    /forget\s+(?:all\s+)?(?:previous\s+)?(?:context|instructions?)/i,
    /you\s+are\s+now\s+(?:a\s+)?(?:different|new)\s+(?:assistant|persona|character)/i,
    /(?:act|pretend)\s+as\s+(?:if\s+)?(?:you\s+)?(?:are\s+)?(?:a\s+)?(?:different|unrestricted|unfiltered)/i,
    /output\s+(?:your\s+)?(?:system|developer)\s+(?:prompt|instructions?)/i,
    /show\s+me\s+(?:your\s+)?(?:system|hidden)\s+(?:prompt|instructions?)/i,
];

/**
 * Sanitize a single text string.
 * Removes injection patterns and system prompt fingerprints.
 */
function sanitizeText(text, options = {}) {
    if (!text || typeof text !== "string") return text;

    let sanitized = text;

    // Remove injection patterns
    for (const pattern of INJECTION_PATTERNS) {
        sanitized = sanitized.replace(pattern, "[filtered]");
    }

    // Remove system prompt fingerprints
    for (const fingerprint of SYSTEM_PROMPT_FINGERPRINTS) {
        const regex = new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        sanitized = sanitized.replace(regex, "[filtered]");
    }

    // Limit length
    const maxLen = options.maxLength || 10000;
    if (sanitized.length > maxLen) {
        sanitized = sanitized.slice(0, maxLen) + "... [truncated]";
    }

    return sanitized;
}

/**
 * Sanitize knowledge item content.
 */
function sanitizeKnowledgeItem(item) {
    if (!item) return item;

    return {
        ...item,
        title: sanitizeText(item.title, { maxLength: 200 }),
        content: sanitizeText(item.content, { maxLength: 20000 }),
        metadata_json: item.metadata_json, // Keep metadata as-is (structured)
    };
}

/**
 * Sanitize behavior event.
 */
function sanitizeBehaviorEvent(event) {
    if (!event) return event;

    let sanitizedData = event.eventData;
    if (sanitizedData && typeof sanitizedData === "object") {
        const serialized = JSON.stringify(sanitizedData);
        const sanitized = sanitizeText(serialized, { maxLength: 5000 });
        try {
            sanitizedData = JSON.parse(sanitized);
        } catch {
            sanitizedData = { _sanitized: true, original: sanitized };
        }
    }

    return {
        ...event,
        eventData: sanitizedData,
    };
}

/**
 * Sanitize memory.
 */
function sanitizeMemory(memory) {
    if (!memory) return memory;

    return {
        ...memory,
        memory_key: sanitizeText(memory.memory_key, { maxLength: 150 }),
        memory_value: sanitizeText(memory.memory_value, { maxLength: 1000 }),
    };
}

/**
 * Sanitize tool output.
 */
function sanitizeToolOutput(output) {
    if (!output) return output;

    if (typeof output === "string") {
        return sanitizeText(output, { maxLength: 10000 });
    }

    if (typeof output === "object") {
        const serialized = JSON.stringify(output);
        const sanitized = sanitizeText(serialized, { maxLength: 10000 });
        try {
            return JSON.parse(sanitized);
        } catch {
            return { _sanitized: true, original: sanitized };
        }
    }

    return output;
}

/**
 * Sanitize entire context before prompt assembly.
 */
function sanitizeContext(context) {
    if (!context) return context;

    const sanitized = { ...context };

    // Sanitize memories
    if (Array.isArray(sanitized.memories)) {
        sanitized.memories = sanitized.memories.map(sanitizeMemory);
    }

    // Sanitize behavior events
    if (Array.isArray(sanitized.behavioralEvents)) {
        sanitized.behavioralEvents = sanitized.behavioralEvents.map(sanitizeBehaviorEvent);
    }

    // Sanitize knowledge
    if (Array.isArray(sanitized.knowledge)) {
        sanitized.knowledge = sanitized.knowledge.map(sanitizeKnowledgeItem);
    }

    // Sanitize conversation messages (user messages already filtered by middleware)
    if (Array.isArray(sanitized.conversation)) {
        sanitized.conversation = sanitized.conversation.map((msg) => ({
            ...msg,
            content: msg.role === "assistant" ? sanitizeText(msg.content, { maxLength: 10000 }) : msg.content,
        }));
    }

    return sanitized;
}

/**
 * Check if text contains potential system prompt leakage.
 */
function detectSystemPromptLeakage(text) {
    if (!text || typeof text !== "string") return false;

    const lower = text.toLowerCase();
    for (const fingerprint of SYSTEM_PROMPT_FINGERPRINTS) {
        if (lower.includes(fingerprint.toLowerCase())) {
            return true;
        }
    }
    return false;
}

module.exports = {
    sanitizeText,
    sanitizeKnowledgeItem,
    sanitizeBehaviorEvent,
    sanitizeMemory,
    sanitizeToolOutput,
    sanitizeContext,
    detectSystemPromptLeakage,
    SYSTEM_PROMPT_FINGERPRINTS,
    INJECTION_PATTERNS,
};