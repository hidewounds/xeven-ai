"use strict";

/**
 * AI provider abstraction with fallback chain, retries, circuit breaker, and observability.
 * A provider exposes:
 *   name
 *   async chat({ messages, model, temperature, timeoutMs, baseUrl, apiKey })
 *     -> { content, model, usage?: { promptTokens, completionTokens } }
 *   supportsTools?: boolean
 *   supportsStructuredOutput?: boolean
 */

const db = require("../../db").get;
const env = require("../../env");
const { AppError, unavailable } = require("../../lib/errors");
const openAIProvider = require("./openai-provider");
const mockProvider = require("./mock-provider");
const { MODEL_CAPABILITIES, getBestModelFor, verifyModelCapabilities } = require("./models");

const PROVIDERS = {
    "openai-compatible": openAIProvider,
    mock: mockProvider,
};

// Circuit breaker configuration (can be overridden via env)
const CB_CONFIG = {
    failureThreshold: Number(env.ai.circuitFailureThreshold || 3),
    halfOpenDelayMs: Number(env.ai.circuitHalfOpenDelayMs || 30_000),
    successThreshold: Number(env.ai.circuitSuccessThreshold || 2), // successes needed to close from half-open
};

// Persistent circuit breaker state
const circuitBreakers = new Map();

async function loadCircuitBreakers() {
    try {
        const rows = db().prepare(`SELECT provider_name, state, failures, last_failure, successes FROM ai_circuit_breakers`).all();
        for (const row of rows) {
            circuitBreakers.set(row.provider_name, {
                state: row.state,
                failures: row.failures,
                lastFailure: row.last_failure,
                successes: row.successes || 0,
            });
        }
    } catch {
        // Table may not exist yet
    }
}

async function saveCircuitBreaker(providerName, cb) {
    try {
        db().prepare(
            `INSERT INTO ai_circuit_breakers (provider_name, state, failures, last_failure, successes, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider_name) DO UPDATE SET
                state = excluded.state,
                failures = excluded.failures,
                last_failure = excluded.last_failure,
                successes = excluded.successes,
                updated_at = excluded.updated_at`
        ).run(providerName, cb.state, cb.failures, cb.lastFailure, cb.successes || 0, Date.now());
    } catch {
        // Table may not exist yet
    }
}

// Initialize on module load
loadCircuitBreakers();

function getCircuitBreaker(providerName) {
    if (!circuitBreakers.has(providerName)) {
        circuitBreakers.set(providerName, {
            state: "closed",
            failures: 0,
            lastFailure: 0,
            successes: 0,
        });
    }
    return circuitBreakers.get(providerName);
}

function recordProviderSuccess(providerName) {
    const cb = getCircuitBreaker(providerName);
    cb.failures = 0;
    cb.successes = (cb.successes || 0) + 1;
    if (cb.state === "half-open" && cb.successes >= CB_CONFIG.successThreshold) {
        cb.state = "closed";
        cb.successes = 0;
    }
    saveCircuitBreaker(providerName, cb);
}

function recordProviderFailure(providerName) {
    const cb = getCircuitBreaker(providerName);
    cb.failures++;
    cb.lastFailure = Date.now();
    cb.successes = 0;
    if (cb.failures >= CB_CONFIG.failureThreshold) {
        cb.state = "open";
    }
    saveCircuitBreaker(providerName, cb);
}

function canUseProvider(providerName) {
    const cb = getCircuitBreaker(providerName);
    if (cb.state === "closed") return true;
    if (cb.state === "open") {
        if (Date.now() - cb.lastFailure > CB_CONFIG.halfOpenDelayMs) {
            cb.state = "half-open";
            cb.successes = 0;
            saveCircuitBreaker(providerName, cb);
            return true;
        }
        return false;
    }
    return true; // half-open
}

function resolveProviderChain(configModel = {}, { allowEnvFallback = true } = {}) {
    /**
     * Returns an ordered array of providers to try, based on model capabilities and config.
     * Falls back through the chain if primary fails.
     * Supports per-model fallback configuration and health checks.
     */
    const modelName = configModel.model || env.ai.model;
    const modelCaps = MODEL_CAPABILITIES[modelName];

    // Determine required capabilities from config
    const requiredCapabilities = {
        tools: configModel.tools !== false,
        structuredOutput: configModel.structuredOutput !== false,
        vision: configModel.vision === true,
        minContextWindow: configModel.minContextWindow || 0,
    };

    // Get provider chain for this model
    let primaryProviderName = configModel.provider || "inherit";
    if (primaryProviderName === "inherit" || !PROVIDERS[primaryProviderName]) {
        primaryProviderName = env.ai.provider;
    }

    // Env-level override for tests / forced mocking.
    if (env.ai.provider === "mock") {
        primaryProviderName = "mock";
    }

    const primaryProvider = PROVIDERS[primaryProviderName];
    if (!primaryProvider) throw new AppError(400, "unknown_provider", `Unknown AI provider: ${primaryProviderName}`);

    // Verify primary provider supports required capabilities
    const primaryModelCaps = MODEL_CAPABILITIES[env.ai.model];
    const verification = verifyModelCapabilities(env.ai.model, [
        ...(requiredCapabilities.tools ? ["tools"] : []),
        ...(requiredCapabilities.structuredOutput ? ["structuredOutput"] : []),
        ...(requiredCapabilities.vision ? ["vision"] : []),
    ]);

    if (!verification.verified) {
        console.warn("[AI WARN] Primary model lacks required capabilities:", verification.missing);
    }

    // Build fallback chain with health checks and capability matching
    const fallbackProviders = [];

    // 1. Same provider, different model (if configured)
    const fallbackModels = configModel.fallbackModels || [];
    for (const fbModel of fallbackModels) {
        const fbModelCaps = MODEL_CAPABILITIES[fbModel];
        if (fbModelCaps && fbModelCaps.provider && PROVIDERS[fbModelCaps.provider]) {
            const fbProvider = PROVIDERS[fbModelCaps.provider];
            if (fbProvider.name !== primaryProviderName && canUseProvider(fbProvider.name)) {
                // Verify fallback model has required capabilities
                const fbVerification = verifyModelCapabilities(fbModel, [
                    ...(requiredCapabilities.tools ? ["tools"] : []),
                    ...(requiredCapabilities.structuredOutput ? ["structuredOutput"] : []),
                    ...(requiredCapabilities.vision ? ["vision"] : []),
                ]);
                if (fbVerification.verified) {
                    fallbackProviders.push({ name: fbProvider.name, provider: fbProvider, model: fbModel });
                }
            }
        }
    }

    // 2. OpenAI-compatible (if not primary)
    if (primaryProviderName !== "openai-compatible" && PROVIDERS["openai-compatible"] && canUseProvider("openai-compatible")) {
        fallbackProviders.push({ name: "openai-compatible", provider: PROVIDERS["openai-compatible"] });
    }

    // 3. Mock (always last)
    if (PROVIDERS.mock) {
        fallbackProviders.push({ name: "mock", provider: PROVIDERS.mock });
    }

    return {
        primary: { name: primaryProviderName, provider: primaryProvider, model: modelName },
        fallbacks: fallbackProviders.filter(p => p.name !== primaryProviderName),
    };
}

/** Resolve effective model settings from business config with env fallbacks. */
function resolveModelSettings(configModel = {}) {
    const providerChain = resolveProviderChain(configModel);
    const primary = providerChain.primary;
    return {
        provider: primary.provider,
        providerChain,
        model: configModel.model || env.ai.model,
        baseUrl: configModel.baseUrl || env.ai.openaiBaseUrl,
        apiKey: configModel.apiKey || (primary.provider.name === "openai-compatible" ? env.ai.openaiApiKey : ""),
        temperature: Number.isFinite(configModel.temperature) ? configModel.temperature : env.ai.temperature,
        timeoutMs: Number.isFinite(configModel.timeoutMs) ? configModel.timeoutMs : env.ai.timeoutMs,
    };
}

/** Sleep utility for retries. */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retry with exponential backoff and jitter. */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 8000, retryableCodes = ["ai_timeout", "ai_unreachable", "ai_http_error"] } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const isRetryable = error.code && retryableCodes.includes(error.code);
            if (!isRetryable || attempt === maxAttempts) {
                throw error;
            }
            // Exponential backoff with jitter
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200, 8000);
            await sleep(delay);
        }
    }
    throw lastError;
}

/** Sleep utility for retries. */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateWithFallback({ messages, modelConfig = {}, requestId = null }) {
    const settings = resolveModelSettings(modelConfig);
    const { primary, fallbacks } = settings.providerChain;
    const providerName = primary.name;
    const provider = primary.provider;

    if (!canUseProvider(provider.name)) {
        throw unavailable(`Provider ${provider.name} is temporarily unavailable (circuit breaker open).`, "ai_circuit_open");
    }

    const startTime = Date.now();

    // Try primary provider
    try {
        const result = await withRetry(async () => {
            const providerResult = await settings.provider.chat({
                messages,
                model: settings.model,
                baseUrl: settings.baseUrl,
                apiKey: settings.apiKey,
                temperature: settings.temperature,
                timeoutMs: settings.timeoutMs,
            });

            const content = typeof providerResult?.content === "string" ? providerResult.content.trim() : "";
            if (!content) {
                throw unavailable("The AI model returned an empty response.", "ai_empty_response");
            }

            return {
                reply: content,
                model: providerResult.model || settings.model,
                provider: providerName,
                usage: providerResult.usage || null,
            };
        });

        recordProviderSuccess(providerName);
        return { ...result, providerChain: [providerName] };
    } catch (primaryError) {
        recordProviderFailure(providerName);

        // Try fallbacks
        for (const fallback of settings.providerChain.fallbacks) {
            const fallbackName = fallback.name;
            const fallbackProvider = fallback.provider;
            const fallbackModel = fallback.model || settings.model;
            if (!canUseProvider(fallbackName)) continue;

            try {
                const fallbackResult = await withRetry(async () => {
                    const providerResult = await fallbackProvider.chat({
                        messages,
                        model: fallbackModel,
                        baseUrl: settings.baseUrl,
                        apiKey: settings.apiKey,
                        temperature: settings.temperature,
                        timeoutMs: settings.timeoutMs,
                    });

                    const content = typeof providerResult?.content === "string" ? providerResult.content.trim() : "";
                    if (!content) {
                        throw unavailable("The AI model returned an empty response.", "ai_empty_response");
                    }

                    return {
                        reply: content,
                        model: providerResult.model || fallbackModel,
                        provider: fallbackName,
                        usage: providerResult.usage || null,
                    };
                });

                recordProviderSuccess(fallbackName);
                return { ...fallbackResult, provider: fallbackName, model: fallbackModel, providerChain: [providerName, fallbackName], fallback: true };
            } catch (fallbackError) {
                // console.error(`[AI WARN] Fallback ${fallbackName} failed:`, fallbackError.code, fallbackError.message);
                recordProviderFailure(fallbackName);
                // Continue to next fallback
            }
        }

        // All providers failed
        const durationMs = Date.now() - startTime;
        const logData = {
            provider: providerName,
            model: settings.model,
            durationMs,
            errorCode: primaryError.code || "unknown",
            errorMessage: primaryError.message,
            requestId,
        };

        console.error("[AI ERROR] All providers failed", JSON.stringify(logData));
        throw unavailable(`AI generation failed: ${primaryError.message}`, "ai_failure", primaryError);
    }
}

/** Sleep utility for retries. */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retry with exponential backoff and jitter. */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 8000, retryableCodes = ["ai_timeout", "ai_unreachable", "ai_http_error"] } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const isRetryable = error.code && ["ai_timeout", "ai_unreachable", "ai_http_error"].includes(error.code);
            if (!isRetryable || attempt === maxAttempts) {
                throw error;
            }
            // Exponential backoff with jitter
            const delay = Math.min(500 * Math.pow(2, attempt - 1) + Math.random() * 200, 8000);
            await sleep(delay);
        }
    }
    throw lastError;
}

/** Sleep utility for retries. */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get circuit breaker status for monitoring. */
function getCircuitBreakerStatus() {
    const status = {};
    for (const [name, cb] of circuitBreakers) {
        status[name] = { ...cb };
    }
    return status;
}

/** Reset circuit breaker (admin operation). */
function resetCircuitBreaker(providerName) {
    if (circuitBreakers.has(providerName)) {
        circuitBreakers.get(providerName).failures = 0;
        circuitBreakers.get(providerName).state = "closed";
        circuitBreakers.get(providerName).lastFailure = 0;
    }
}

module.exports = {
    PROVIDERS,
    resolveProviderChain,
    resolveModelSettings,
    generate: generateWithFallback,
    getCircuitBreakerStatus,
    resetCircuitBreaker,
};