"use strict";

/**
 * Canonical default business configuration. Every field a business can
 * customize lives here; stored configuration is always deep-merged onto
 * this shape so upgrades add new defaults automatically.
 */

const DEFAULT_STABLE_FIELDS = [
    {
        key: "name",
        category: "identity",
        description: "The customer's name.",
        keywords: ["name", "called"],
    },
    {
        key: "location",
        category: "identity",
        description: "The customer's general location.",
        keywords: ["location", "city", "country", "live", "based"],
    },
    {
        key: "occupation",
        category: "fact",
        description: "The customer's job or occupation.",
        keywords: ["job", "occupation", "work as"],
    },
    {
        key: "shoe_size",
        category: "preference",
        description: "The customer's shoe size.",
        keywords: ["shoe size"],
    },
    {
        key: "clothing_size",
        category: "preference",
        description: "The customer's clothing size.",
        keywords: ["clothing size", "shirt size", "pant size", "clothes size"],
    },
    {
        key: "shoe_preference",
        category: "preference",
        description: "The customer's shoe preferences.",
        keywords: ["shoe preference", "shoes", "shoe color", "shoe style"],
    },
];

const BEHAVIOR_EVENT_TYPES = [
    "page_view",
    "product_view",
    "search",
    "category_view",
    "cart",
    "wishlist",
    "purchase",
];

/**
 * Commercial plans — Unified Brain (no role limits).
 * Previously `maxRoles` capped stacked skills; now one unified brain learns all 6 patterns fluidly.
 * Plans now differentiate by usage, features, and Custom Agent Behaviour Builder limits.
 * Training: RLHF pattern learning (rkinas) — reward optimizes task-completion, satisfaction, accuracy.
 * Custom Behaviour: business can define situation-specific overrides (trigger -> pattern/tone/instructions).
 */
const PLANS = {
    launch: { label: "Launch", maxRoles: null, description: "Unified brain — 1k chats, 50 knowledge — no Chrono/Echo", limits: { conversations: 1000, knowledgeItems: 50, bookings: false, customBehaviours: 0, maxCustomRules: 0 } },
    growth: { label: "Growth", maxRoles: null, description: "Unified brain — 10k chats, 200 knowledge + Chrono + Echo English", limits: { conversations: 10000, knowledgeItems: 200, bookings: true, customBehaviours: 0, maxCustomRules: 0 } },
    scale: { label: "Scale", maxRoles: null, description: "Unified brain — 50k chats, 500 knowledge + all add-ons (Chrono+Echo+Voice+Multilanguage) 10 rules", limits: { conversations: 50000, knowledgeItems: 500, bookings: true, customBehaviours: 10, maxCustomRules: 10 } },
    custom: { label: "Custom", maxRoles: null, description: "Bespoke — unlimited chats/knowledge/rules + custom RLHF — full analysis", limits: { conversations: Infinity, knowledgeItems: Infinity, bookings: true, customBehaviours: Infinity, maxCustomRules: Infinity } },
    unlimited: { label: "Custom", maxRoles: null, description: "Bespoke — unlimited (legacy alias for Custom)", limits: { conversations: Infinity, knowledgeItems: Infinity, bookings: true, customBehaviours: Infinity, maxCustomRules: Infinity } },
};

// Custom Agent Behaviour — plan-gated builder that lets businesses define situation-specific overrides
// Each rule: { id, name, trigger, patternWeights, tone, instructions, priority, enabled }
const CUSTOM_BEHAVIOUR_PATTERNS = ["customer_support","sales","shopping_assistant","product_advisor","lead_qualification","general_assistant"];

const DEFAULT_CONFIG = {
    version: 1,

    assistant: {
        name: "XEVEN",
        // Unified brain — no role switching. Agent is one brain with learned expertise across 6 patterns.
        // Legacy `role`/`roles` kept for backward compat but ignored; see server/src/core/agent/brain.js
        role: "unified",
        roles: ["unified"],
        businessDescription: "",
        instructions: "",
        personality: "",
        tone: "",
        welcomeMessage: "",
        fallbackMessage: "I don't have verified information on that — would you like me to connect you to a human at the business?",
        brain: "unified", // one brain, 6 learned patterns (customer_support, sales, shopping_assistant, product_advisor, lead_qualification, general_assistant)
    },

    model: {
        provider: "inherit", // openai-compatible | mock | inherit (env)
        model: "",          // empty = provider/env default
        baseUrl: "",        // empty = provider/env default
        apiKey: "",         // secret; stripped from all API responses
        temperature: 0.7,
        timeoutMs: 120000,
    },

    memory: {
        enabled: true,
        maxMemories: 50,
        allowExplicitRemember: true,
        stableFields: DEFAULT_STABLE_FIELDS,
    },

    behavior: {
        enabled: true,
        maxEvents: 100,
        defaultRetentionDays: 30,
        events: {
            page_view: { enabled: true, retentionDays: 7 },
            product_view: { enabled: true, retentionDays: 30 },
            search: { enabled: true, retentionDays: 14 },
            category_view: { enabled: true, retentionDays: 14 },
            cart: { enabled: true, retentionDays: 7 },
            wishlist: { enabled: true, retentionDays: 30 },
            purchase: { enabled: true, retentionDays: 365 },
        },
    },

    context: {
        maxMemories: 5,
        maxBehavior: 10,
        maxKnowledge: 6,
        maxConversationMessages: 20,
        minimumMemoryScore: 1,
        minimumBehaviorScore: 1,
        maxContextTokens: 6000,
    },

    features: {
        conversations: true,
        knowledge: true,
        // Per-capability switches for agent ACTIONS (booking.*, etc.).
        // Unified brain: gating is business-level only (no role gate). One brain has learned all 6 patterns.
        capabilities: {
            "booking.availability": true,
            "booking.create": true,
            "booking.list": true,
            "chrono.schedule.get": true,
            "chrono.schedule.set": true,
            "echo.transcribe": true,
            "call.handoff": true,
        },
    },

    chrono: {
        timezone: "UTC",
        slotDuration: 60,
        bufferMinutes: 0,
        minNoticeMinutes: 0,
        maxDaysAhead: 60,
        maxSeatsPerSlot: 1,
        hosts: [],
        weekly: {
            monday: [{ start: "09:00", end: "17:00" }],
            tuesday: [{ start: "09:00", end: "17:00" }],
            wednesday: [{ start: "09:00", end: "17:00" }],
            thursday: [{ start: "09:00", end: "17:00" }],
            friday: [{ start: "09:00", end: "17:00" }],
            saturday: [],
            sunday: [],
        },
    },

    echo: {
        enabled: false,
        defaultLanguage: "en",
        model: "tiny",
        sidecarUrl: "http://127.0.0.1:8765",
        wordTimestamps: false,
        initialPrompt: "",
    },

    addons: {
        voice_channel: false,
        multilanguage: false,
        custom_behaviour: false, // legacy add-on gate for extra custom rules (unlimited plan auto-enables)
    },

    call: {
        greetingTemplate: "Hello, thank you for calling {businessName}. You're speaking with {agentName}, the AI assistant. I'm here to help with your queries — what can I do for you today?",
        handoffPhone: "",
        handoffEmail: "",
    },

    site: {
        url: "", // linked website URL for guide + learn
        lastAnalyzedAt: null,
    },

    security: {
        widgetEnabled: true,
        allowedOrigins: [],
    },

    // Custom Agent Behaviour Builder — business-defined situation overrides
    // Each rule teaches the unified brain: "when trigger matches, emphasize these patterns + tone + instructions"
    // Enforced per plan: launch 0, growth 3, scale 10, unlimited ∞ (via PLANS.limits.maxCustomRules)
    agentBehaviour: {
        enabled: true,
        rules: [], // { id, name, trigger, triggerType, primaryPattern, tone, instructions, weightBoost, enabled }
    },
};

module.exports = { DEFAULT_CONFIG, DEFAULT_STABLE_FIELDS, BEHAVIOR_EVENT_TYPES, PLANS, CUSTOM_BEHAVIOUR_PATTERNS };
