"use strict";

/**
 * Reward function for XEVEN Unified Brain RLHF
 * Based on rkinas/reasoning_models_how_to — Methods for LLM Training (PPO/DPO/GRPO)
 * 
 * Optimizes for: task-completion-success, user-satisfaction, knowledge-accuracy
 * NOT for: role-adherence (explicitly excluded)
 */

const LEARNED_PATTERNS = require("../server/src/core/agent/brain").LEARNED_PATTERNS;

/**
 * Reward weights per pattern (from brain.js)
 * Each pattern has different emphasis: sales cares more about task, product_advisor more about accuracy
 */
function getWeights(patternId) {
    const pattern = LEARNED_PATTERNS[patternId] || LEARNED_PATTERNS.general_assistant;
    return pattern.rewardWeight;
}

/**
 * Task completion: verifiable via DB/tools
 * - booking.create executed and confirmed -> 1.0
 * - booking.availability correctly shown -> 0.8
 * - question answered from knowledge with citation -> 0.9
 * - lead qualified (progressive questions) -> 0.7
 */
function taskCompletionReward({ conversation, toolOutcomes, knowledgeCited, patternId }) {
    if (!conversation || !conversation.length) return 0;
    const lastAssistant = [...conversation].reverse().find(m => m.role === "assistant");
    const content = String(lastAssistant?.content || "").toLowerCase();
    
    let score = 0;
    
    // Verifiable tool outcomes
    if (toolOutcomes && toolOutcomes.some(o => o.status === "ok" && o.data && o.data.bookingRef)) {
        score = Math.max(score, 1.0); // booking confirmed
    }
    if (toolOutcomes && toolOutcomes.some(o => o.status === "ok" && o.data && Array.isArray(o.data.days))) {
        score = Math.max(score, 0.8);
    }
    if (toolOutcomes && toolOutcomes.some(o => o.status === "ok" && o.data && Array.isArray(o.data.bookings))) {
        score = Math.max(score, 0.7);
    }
    
    // Knowledge citation
    if (knowledgeCited && content.length > 20) {
        score = Math.max(score, 0.9);
    }
    
    // Fallback: did we avoid fallbackMessage when knowledge existed?
    if (content && !content.includes("don't have verified") && !content.includes("failed to fetch") && content.length > 30) {
        score = Math.max(score, 0.5);
    }
    
    // No tool, no citation, but still responded helpfully (general)
    if (score === 0 && content.length > 20) score = 0.3;
    
    return Math.min(1, score);
}

/**
 * User satisfaction: implicit + explicit
 * - Explicit: thumbs up/down, "thanks", "perfect", "great"
 * - Implicit: follow-up engagement, no complaint, conversation continued
 * - Negative: "not helpful", "wrong", "useless", early exit
 */
function satisfactionReward({ conversation, patternId }) {
    const text = conversation.map(m => String(m.content||"")).join(" ").toLowerCase();
    let score = 0.5; // neutral baseline
    
    if (/\b(thanks|thank you|perfect|great|awesome|helpful|exactly|love it)\b/.test(text)) score += 0.4;
    if (/\b(not helpful|wrong|useless|bad|terrible|annoying|frustrat)\b/.test(text)) score -= 0.4;
    if (conversation.length >= 4) score += 0.1; // continued engagement
    if (conversation.length === 2 && text.includes("failed to fetch")) score -= 0.2;
    
    // Pattern-specific: sales should have close cues, support should have empathy
    const pattern = patternId;
    if (pattern === "customer_support" && /\b(sorry|understand|empathy|follow.*up)\b/.test(text)) score += 0.15;
    if (pattern === "sales" && /\b(value|benefit|recommend|suggest)\b/.test(text)) score += 0.15;
    
    return Math.max(0, Math.min(1, score));
}

/**
 * Knowledge accuracy: grounded, no hallucination, cited
 * - Verifiable: does reply contain claims that are in RELEVANT BUSINESS KNOWLEDGE?
 * - Citation: does it cite knowledge title when used?
 * - No hallucination: does it avoid inventing price/specs not in knowledge?
 */
function accuracyReward({ reply, knowledge = [], patternId }) {
    const content = String(reply || "").toLowerCase();
    const knowledgeText = knowledge.map(k => `${k.title} ${k.content}`).join(" ").toLowerCase();
    
    if (!knowledge.length) {
        // No knowledge retrieved — accuracy is about NOT hallucinating
        if (content.includes("don't have verified") || content.includes("failed to fetch") || content.includes("connect you to a human")) {
            return 0.9; // correctly abstained
        }
        // Check for hallucinated numbers when no knowledge has numbers
        const hasNumbers = /\$\s?\d+/.test(content);
        const knowledgeHasNumbers = /\$\s?\d+/.test(knowledgeText);
        if (hasNumbers && !knowledgeHasNumbers) return 0.2; // hallucinated price
        return 0.7;
    }
    
    let score = 0.6;
    
    // Citation bonus
    const titles = knowledge.map(k => String(k.title||"").toLowerCase());
    if (titles.some(t => t && content.includes(t.slice(0, 10)))) score += 0.2;
    
    // Numbers in reply should be in knowledge
    const replyNumbers = [...content.matchAll(/\$\s?\d+/g)].map(m=>m[0]);
    const knowledgeNumbers = new Set([...knowledgeText.matchAll(/\$\s?\d+/g)].map(m=>m[0]));
    if (replyNumbers.length) {
        const grounded = replyNumbers.filter(n => knowledgeNumbers.has(n)).length;
        score += 0.2 * (grounded / replyNumbers.length);
        if (grounded !== replyNumbers.length) score -= 0.3; // hallucinated one
    }
    
    // No hallucination phrase
    if (content.includes("failed to fetch") && knowledge.length) {
        // Should have answered from knowledge but said failed — inaccurate
        score -= 0.3;
    }
    
    return Math.max(0, Math.min(1, score));
}

/**
 * Custom Behaviour adherence (optional): if a custom rule was active, did reply respect its tone/instructions?
 * This is NOT role-adherence — it's business-defined situational preference, still optimizing outcomes.
 * Weight is small (0.1) and only applies when customBehaviour rule triggered.
 */
function customBehaviourReward({ reply, customRule, patternId }) {
    if (!customRule) return 1.0; // no custom rule active -> neutral, don't penalize
    const content = String(reply || "").toLowerCase();
    let score = 0.6;
    // Did reply respect custom tone hint?
    if (customRule.tone && content.length > 20) {
        const toneWords = String(customRule.tone).toLowerCase().split(/\W+/).filter(w=>w.length>3);
        const matched = toneWords.filter(w=>content.includes(w)).length;
        if (matched > 0) score += 0.2;
    }
    // Did reply respect custom instructions keyword?
    if (customRule.instructions && content.length > 20) {
        const key = String(customRule.instructions).toLowerCase().slice(0, 30).split(/\W+/).find(w=>w.length>4);
        if (key && content.includes(key)) score += 0.2;
    }
    // Did reply activate correct pattern?
    if (customRule.primaryPattern && patternId === customRule.primaryPattern) score += 0.15;
    return Math.max(0, Math.min(1, score));
}

/**
 * Combined reward — NOT role-adherence
 * Role-adherence is explicitly NOT in reward; only outcomes matter.
 * This is key to pattern learning: agent learns "situation X -> pattern Y is effective" not "this is support role so do Z"
 * Custom behaviour is additive (bonus) when business has defined situational overrides — still outcome-weighted.
 */
function computeReward({ conversation, reply, knowledge, toolOutcomes, patternId, knowledgeCited, customRule }) {
    const weights = getWeights(patternId);
    const task = taskCompletionReward({ conversation, toolOutcomes, knowledgeCited, patternId });
    const sat = satisfactionReward({ conversation, patternId });
    const acc = accuracyReward({ reply, knowledge, patternId });
    const custom = customBehaviourReward({ reply, customRule, patternId });
    
    // Base is still task+sat+acc; custom is bonus when present (up to +0.1)
    let total = weights.taskCompletion * task + weights.satisfaction * sat + weights.accuracy * acc;
    if (customRule) {
        total = total * 0.9 + custom * 0.1; // blend 10% custom when rule active
    }
    
    return {
        total: Math.max(0, Math.min(1, total)),
        breakdown: { taskCompletion: task, satisfaction: sat, knowledgeAccuracy: acc, customBehaviour: custom, weights },
        patternId,
        customRule: customRule ? customRule.id : null,
        // For DPO/GRPO logging
        isPreferred: total > 0.7, // threshold for preference pair
    };
}

/**
 * Preference pair for DPO: given same situation, which response is better?
 * Used to train reward model from human feedback
 */
function preferencePair({ situation, responseA, responseB, knowledge, toolOutcomes }) {
    const rewardA = computeReward({ conversation: [{role:"user",content:situation},{role:"assistant",content:responseA}], reply: responseA, knowledge, toolOutcomes, patternId: "general_assistant" });
    const rewardB = computeReward({ conversation: [{role:"user",content:situation},{role:"assistant",content:responseB}], reply: responseB, knowledge, toolOutcomes, patternId: "general_assistant" });
    
    const preferred = rewardA.total > rewardB.total ? responseA : responseB;
    const rejected = rewardA.total > rewardB.total ? responseB : responseA;
    const margin = Math.abs(rewardA.total - rewardB.total);
    
    return {
        prompt: situation,
        chosen: preferred,
        rejected,
        margin,
        rewardChosen: Math.max(rewardA.total, rewardB.total),
        rewardRejected: Math.min(rewardA.total, rewardB.total),
    };
}

module.exports = {
    computeReward,
    taskCompletionReward,
    satisfactionReward,
    accuracyReward,
    preferencePair,
    getWeights,
};
