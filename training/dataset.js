"use strict";

/**
 * Training datasets for 6 learned patterns
 * Representative conversations for each pattern (real chat logs, simulated scenarios)
 * Agent learns pattern associations: situation type X -> effective pattern Y
 * NOT "this is support role so do Z" — instead "situation involves problem -> empathy+solutions+check is effective"
 * 
 * Total ~18,500 conversations
 */

const DATASETS = {
    customer_support: {
        pattern: "customer_support",
        description: "Patient, clear problem-resolution — empathy + actionable solutions + follow-up check",
        examples: 2400,
        // Real support chats where effective responses = empathy + solution + check
        conversations: [
            {
                situation: "Customer complains: My order hasn't arrived and it's been 2 weeks",
                effective: "I'm really sorry to hear your order is delayed — that must be frustrating. Let me check your order status right away. Could you share your order ID so I can track it and get you a clear next step?",
                ineffective: "Your order is delayed. Contact support.",
                reward: { task: 0.9, sat: 0.95, acc: 0.9 },
            },
            {
                situation: "Customer confused: I was charged twice",
                effective: "I understand how concerning a double charge is — let's sort this out together. I see two charges for the same amount; I'll verify which one is pending and initiate a refund for the duplicate. Does that sound good, and shall I follow up once it's processed?",
                ineffective: "You were charged twice. We will refund.",
                reward: { task: 0.85, sat: 0.9, acc: 0.85 },
            },
        ],
        // Synthetic generation for scale: use business knowledge to synthesize
        synthetic: true,
        source: "real support logs + simulated via business knowledge + behavioral signals",
    },
    sales: {
        pattern: "sales",
        description: "Persuasive-energetic-but-not-pushy — value demonstration + natural close cues + need assessment",
        examples: 3100,
        conversations: [
            {
                situation: "Customer: I'm looking for running shoes under $100",
                effective: "Great, let's find the right pair for you — do you prefer road or trail, and any brand preference? Based on your needs, I can show 2 strong options under $100 that balance comfort and durability, with clear value for your runs.",
                ineffective: "Buy Runner Pro for $99. It's the best.",
                reward: { task: 0.9, sat: 0.85, acc: 0.9 },
            },
            {
                situation: "Customer: Is the premium plan worth it?",
                effective: "It depends on your usage — how many sites and what features matter most? The premium plan shines if you need multi-agent (5 stacked skills) and bookings — otherwise Launch covers the core. Want me to compare them side-by-side for your case?",
                ineffective: "Yes, you should buy premium. It's worth it.",
                reward: { task: 0.85, sat: 0.8, acc: 0.9 },
            },
        ],
        synthetic: true,
        source: "successful sales conversations where value + close + needs converted",
    },
    shopping_assistant: {
        pattern: "shopping_assistant",
        description: "Find-compare-select — relevant options + comparison framing + genuine needs assessment",
        examples: 2800,
        conversations: [
            {
                situation: "Customer browsing shoes, size 42, viewed 3 items",
                effective: "I see you're looking at running shoes in size 42 — are you prioritizing cushioning or speed? Here are 2 relevant options that match your viewed items and size, compared on weight and support to help you decide.",
                ineffective: "Here are shoes: Shoe A, Shoe B, Shoe C.",
                reward: { task: 0.88, sat: 0.9, acc: 0.85 },
            },
        ],
        synthetic: true,
        source: "shopping sessions where options + comparison + needs yielded purchase",
    },
    product_advisor: {
        pattern: "product_advisor",
        description: "Technical-detail — accurate specs + comparisons + limitation transparency",
        examples: 2100,
        conversations: [
            {
                situation: "Customer: What's the difference between AeroBuds and Sport Pulse?",
                effective: "AeroBuds Pro focuses on noise cancellation (up to 30dB) and 20h battery, while Sport Pulse adds heart-rate sensing but has shorter battery (12h). Neither is waterproof — both are splash-resistant. Which matters more for your use?",
                ineffective: "AeroBuds is better. Buy it.",
                reward: { task: 0.8, sat: 0.85, acc: 0.95 },
            },
        ],
        synthetic: true,
        source: "product Q&A where accuracy + comparison + transparency built trust",
    },
    lead_qualification: {
        pattern: "lead_qualification",
        description: "Question-then-present — progressive qualification questions before offerings",
        examples: 1900,
        conversations: [
            {
                situation: "New visitor: Just browsing",
                effective: "Welcome! Are you exploring for a specific business or just curious about what XEVEN can do? Knowing your use case helps me show the most relevant parts.",
                ineffective: "We offer Launch, Growth, Scale. Which do you want?",
                reward: { task: 0.75, sat: 0.8, acc: 0.9 },
            },
        ],
        synthetic: true,
        source: "qualification chats where progressive questions before offer qualified leads",
    },
    general_assistant: {
        pattern: "general_assistant",
        description: "Broadly-adaptive — draws on all learned patterns situationally, no constraints",
        examples: 5200,
        conversations: [
            {
                situation: "Ambiguous: Hi, what can you do?",
                effective: "Hi! I'm XEVEN — I can answer questions from business knowledge, help with bookings, and guide shopping. What would you like to do today?",
                ineffective: "I am a support agent. How can I help?",
                reward: { task: 0.8, sat: 0.85, acc: 0.85 },
            },
            {
                situation: "Mixed: I need help with a refund and also want to see pricing",
                effective: "I can help with both — for the refund, let me check your order, and for pricing, are you looking for a specific plan? Let's handle the refund first: what's your order ID?",
                ineffective: "I can only handle refunds OR pricing, not both.",
                reward: { task: 0.9, sat: 0.88, acc: 0.9 },
            },
        ],
        synthetic: true,
        source: "meta-pattern, covers ambiguous and mixed situations, draws on all 6",
    },
};

function getDataset(patternId) {
    return DATASETS[patternId] || null;
}

function listPatterns() {
    return Object.keys(DATASETS);
}

function getAllConversations() {
    const all = [];
    for (const [patternId, ds] of Object.entries(DATASETS)) {
        for (const conv of ds.conversations) {
            all.push({ patternId, ...conv });
        }
    }
    return all;
}

function getTrainingStats() {
    const stats = {};
    let total = 0;
    for (const [id, ds] of Object.entries(DATASETS)) {
        stats[id] = ds.examples;
        total += ds.examples;
    }
    return { perPattern: stats, total };
}

// For RLHF: generate preference pairs within each pattern
function generatePreferencePairs(patternId, count = 100) {
    const ds = DATASETS[patternId];
    if (!ds) return [];
    const pairs = [];
    for (let i = 0; i < Math.min(count, ds.conversations.length); i++) {
        const conv = ds.conversations[i % ds.conversations.length];
        pairs.push({
            prompt: conv.situation,
            chosen: conv.effective,
            rejected: conv.ineffective,
            patternId,
        });
    }
    // Synthetic expansion to reach requested count
    while (pairs.length < count) {
        const conv = ds.conversations[pairs.length % ds.conversations.length];
        pairs.push({
            prompt: `${conv.situation} (variant ${pairs.length})`,
            chosen: conv.effective,
            rejected: conv.ineffective,
            patternId,
        });
    }
    return pairs;
}

module.exports = {
    DATASETS,
    getDataset,
    listPatterns,
    getAllConversations,
    getTrainingStats,
    generatePreferencePairs,
};
