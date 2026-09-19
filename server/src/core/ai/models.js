"use strict";

/**
 * Model capability registry and routing.
 * Defines what each model can do, enabling smart routing.
 */

const env = require("../../env");

const MODEL_CAPABILITIES = {
    // OpenAI-compatible (cloud)
    "gpt-4o-mini": {
        name: "gpt-4o-mini",
        provider: "openai-compatible",
        tools: true,
        structuredOutput: true,
        contextWindow: 128000,
        vision: true,
        multilingual: true,
        reasoning: "high",
        speed: "fast",
        cost: "low",
        tier: "cloud",
    },
    "gpt-4o": {
        name: "gpt-4o",
        provider: "openai-compatible",
        tools: true,
        structuredOutput: true,
        contextWindow: 128000,
        vision: true,
        multilingual: true,
        reasoning: "very_high",
        speed: "medium",
        cost: "high",
        tier: "cloud",
    },
    "gpt-3.5-turbo": {
        name: "gpt-3.5-turbo",
        provider: "openai-compatible",
        tools: true,
        structuredOutput: true,
        contextWindow: 16384,
        vision: false,
        multilingual: true,
        reasoning: "medium",
        speed: "fast",
        cost: "low",
        tier: "cloud",
    },

    // Mock (testing)
    "mock": {
        name: "mock",
        provider: "mock",
        tools: true,
        structuredOutput: true,
        contextWindow: 4096,
        vision: false,
        multilingual: false,
        reasoning: "none",
        speed: "instant",
        cost: "free",
        tier: "test",
    },
};

const TIER_HIERARCHY = {
    test: 0,
    cloud: 3,
};

function getModelCapabilities(modelName) {
    return MODEL_CAPABILITIES[modelName] || null;
}

function listModelsByCapability(capability) {
    return Object.values(MODEL_CAPABILITIES).filter(m => m[capability] === true);
}

function listModelsByTier(tier) {
    return Object.values(MODEL_CAPABILITIES).filter(m => m.tier === tier);
}

function getBestModelFor(requirements = {}) {
    const {
        tools = false,
        structuredOutput = false,
        vision = false,
        reasoning = "none",
        maxCost = "high",
        preferredTier = null,
        minContextWindow = 0,
    } = requirements;

    let candidates = Object.values(MODEL_CAPABILITIES);

    // Filter by hard requirements
    if (tools) candidates = candidates.filter(m => m.tools);
    if (structuredOutput) candidates = candidates.filter(m => m.structuredOutput);
    if (vision) candidates = candidates.filter(m => m.vision);
    if (minContextWindow) candidates = candidates.filter(m => m.contextWindow >= minContextWindow);

    // Filter by reasoning level
    const reasoningLevels = { none: 0, low: 1, medium: 2, high: 3, very_high: 4 };
    const requiredReasoning = reasoningLevels[reasoning] || 0;
    candidates = candidates.filter(m => (reasoningLevels[m.reasoning] || 0) >= requiredReasoning);

    // Filter by cost
    const costLevels = { free: 0, low: 1, medium: 2, high: 3 };
    const maxCostLevel = costLevels[maxCost] ?? 3;
    candidates = candidates.filter(m => (costLevels[m.cost] ?? 3) <= maxCostLevel);

    // Filter by tier preference
    if (preferredTier) {
        candidates = candidates.filter(m => m.tier === preferredTier);
    }

    if (!candidates.length) return null;

    // Sort by preference: cheaper tiers first, then by speed/reasoning
    candidates.sort((a, b) => {
        const tierDiff = TIER_HIERARCHY[a.tier] - TIER_HIERARCHY[b.tier];
        if (tierDiff !== 0) return tierDiff;
        // Prefer higher reasoning
        const reasoningDiff = (reasoningLevels[b.reasoning] || 0) - (reasoningLevels[a.reasoning] || 0);
        if (reasoningDiff !== 0) return reasoningDiff;
        // Prefer faster
        const speedOrder = { instant: 0, fast: 1, medium: 2, slow: 3 };
        return (speedOrder[a.speed] || 3) - (speedOrder[b.speed] || 3);
    });

    return candidates[0] || null;
}

function verifyModelCapabilities(modelName, requiredCapabilities) {
    const caps = getModelCapabilities(modelName);
    if (!caps) return { verified: false, reason: "Model not found" };

    const missing = requiredCapabilities.filter(cap => !caps[cap]);
    return {
        verified: missing.length === 0,
        missing,
        capabilities: caps,
    };
}

function getProviderHealth(providerName) {
    // This would be called to check if a provider is healthy
    // Implementation depends on provider
    return { status: "unknown" };
}

module.exports = {
    MODEL_CAPABILITIES,
    TIER_HIERARCHY,
    getModelCapabilities,
    listModelsByCapability,
    listModelsByTier,
    getBestModelFor,
    verifyModelCapabilities,
    getProviderHealth,
};