"use strict";

/**
 * Training config for XEVEN Unified Brain
 * Based on rkinas/reasoning_models_how_to — Methods for LLM Training
 * Supports PPO, DPO, GRPO, KTO, etc. We use DPO as primary (simple, no reward model needed), GRPO for verifiable rewards
 */

module.exports = {
    // Base model (openai-compatible or local)
    baseModel: process.env.XEVEN_TRAIN_BASE_MODEL || "gpt-4o-mini",
    provider: process.env.XEVEN_TRAIN_PROVIDER || "openai-compatible",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",

    // Methods from rkinas repo
    methods: {
        dpo: {
            enabled: true,
            beta: 0.1, // DPO beta from rkinas minimal_implementation/dpo_trainer.py
            learningRate: 5e-7,
            epochs: 3,
            batchSize: 4,
            description: "Direct Preference Optimization — Your Language Model is Secretly a Reward Model (Stanford)",
        },
        ppo: {
            enabled: true,
            learningRate: 1e-5,
            clipRange: 0.2,
            epochs: 4,
            description: "Proximal Policy Optimization — OpenAI",
        },
        grpo: {
            enabled: true,
            groupSize: 4, // GRPO: group relative policy optimization, no value model
            beta: 0.04,
            description: "Group Relative Policy Optimization — for verifiable rewards (task completion)",
        },
        kto: {
            enabled: false,
            description: "KTO: Model Alignment as Prospect Theoretic Optimization",
        },
    },

    // Reward weights (from brain.js) are used, not role-adherence
    reward: {
        // NOT optimized: role-adherence (explicitly excluded)
        // Optimized: taskCompletion, satisfaction, accuracy
        normalize: true,
        clip: [0, 1],
    },

    // Dataset
    dataset: {
        totalExamples: 18500,
        perPattern: {
            customer_support: 2400,
            sales: 3100,
            shopping_assistant: 2800,
            product_advisor: 2100,
            lead_qualification: 1900,
            general_assistant: 5200,
        },
        trainSplit: 0.9,
        evalSplit: 0.1,
    },

    // Inference
    inference: {
        maxTokens: 150,
        temperature: 0.7,
        patternActivationThreshold: 0.5,
    },

    // Logging
    logging: {
        wandb: false,
        logInterval: 10,
        evalInterval: 100,
    },
};
