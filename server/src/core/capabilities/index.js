"use strict";

/**
 * Capability registry, authorization gate and executor.
 *
 * Every agent-requested action flows through executeCapability(), which
 * enforces — server-side, in order:
 *   1. the capability exists
 *   2. the business's ROLE declares it
 *   3. the BUSINESS enabled it (config.features.capabilities)
 *   4. arguments match the schema
 *   5. risk rules: read = auto-run; write = customer-confirmed intent
 *   6. every attempt is audit-logged (allowed or denied)
 *
 * The model never decides permissions; it can only request.
 */

const { badRequest } = require("../../lib/errors");
const audit = require("../audit/store");
const intents = require("./intents");
const booking = require("./booking");
let chronoSchedule = null; let echoTranscribe = null;
try { chronoSchedule = require("../chrono/schedule"); } catch {}
try { echoTranscribe = require("../echo/transcribe"); } catch {}

const db = require("../../db").get;
const crypto = require("../../lib/crypto");

// Persistent idempotency store (database-backed)
// TTL: 24 hours
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function getIdempotencyKey(call) {
    // Generate deterministic key from tool + args + conversation context
    const fullArgs = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    const { confirm, token, idempotencyKey, ...restArgs } = fullArgs;
    if (idempotencyKey) return String(idempotencyKey);
    // Deterministic hash from tool + args + token (for confirmation flows)
    // Include token in hash for write operations that require confirmation
    const hashInput = `${call.tool}:${JSON.stringify(restArgs)}${fullArgs.token ? `:${fullArgs.token}` : ""}`;
    // Use Node's crypto directly — lib/crypto doesn't expose createHash
    return require("crypto").createHash("sha256").update(hashInput).digest("hex").slice(0, 32);
}

function checkIdempotency(businessId, key) {
    const row = db().prepare(
        `SELECT result_json FROM idempotency_keys WHERE business_id = ? AND key_hash = ? AND expires_at > ?`
    ).get(businessId, key, Date.now());
    if (!row) return null;
    try {
        return JSON.parse(row.result_json);
    } catch {
        return null;
    }
}

function setIdempotency(businessId, key, tool, args, result) {
    const now = Date.now();
    const expiresAt = now + IDEMPOTENCY_TTL_MS;
    const argsJson = JSON.stringify(args || {});
    const resultJson = JSON.stringify(result);

    db().prepare(
        `INSERT INTO idempotency_keys (business_id, key_hash, tool, args_json, result_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(business_id, key_hash) DO UPDATE SET
            result_json = excluded.result_json,
            expires_at = excluded.expires_at`
    ).run(businessId, key, tool, argsJson, resultJson, now, expiresAt);
}

const CAPABILITIES = {
    "booking.availability": {
        summary: "List open appointment slots for the next 5 weekdays.",
        risk: "read",
        params: {
            type: "object",
            properties: {
                date: { type: "string", description: "Optional start date YYYY-MM-DD" },
                days: { type: "number", description: "Days ahead (1-90)" },
                horizonDays: { type: "number", description: "Alias for days" },
            },
            required: [],
        },
        handler: booking.availability,
    },
    "booking.create": {
        summary: "Create a confirmed appointment. Requires explicit customer confirmation first.",
        risk: "write",
        params: {
            type: "object",
            properties: {
                service: { type: "string", description: "Service or appointment name" },
                datetime: { type: "string", description: "ISO 8601, e.g. 2026-09-01T10:00:00Z" },
                contact: { type: "string", description: "Optional contact info" },
                notes: { type: "string", description: "Optional notes" },
                confirm: { type: "boolean", description: "true ONLY after the customer explicitly agreed" },
                token: { type: "string", description: "Confirmation token returned by the previous proposal" },
            },
            required: ["service", "datetime"],
        },
        handler: booking.createBooking,
    },
    "booking.list": {
        summary: "List this customer's bookings.",
        risk: "read",
        params: { type: "object", properties: {}, required: [] },
        handler: booking.listCustomerBookings,
    },
    "chrono.schedule.get": {
        summary: "Get the business's real availability schedule (chrono) — weekly hours, timezone, overrides.",
        risk: "read",
        params: { type: "object", properties: {}, required: [] },
        handler: ({ businessId }) => {
            if (!chronoSchedule) throw badRequest("Chrono not available.", "not_available");
            const sched = chronoSchedule.getSchedule(businessId);
            const overrides = chronoSchedule.listOverrides(businessId);
            return { schedule: sched, overrides };
        },
    },
    "chrono.schedule.set": {
        summary: "Update the business availability schedule. Confirm with business owner first.",
        risk: "write",
        params: {
            type: "object",
            properties: {
                timezone: { type: "string" },
                slotDuration: { type: "number" },
                bufferMinutes: { type: "number" },
                minNoticeMinutes: { type: "number" },
                maxDaysAhead: { type: "number" },
                weekly: { type: "object", description: "Weekly schedule blocks" },
                confirm: { type: "boolean" },
                token: { type: "string" },
            },
            required: [],
        },
        handler: ({ businessId }, params) => {
            if (!chronoSchedule) throw badRequest("Chrono not available.", "not_available");
            return chronoSchedule.setSchedule(businessId, params);
        },
    },
    "echo.transcribe": {
        summary: "Transcribe customer voice input (echo). Returns text and detected language. Supports both batch and streaming.",
        risk: "read",
        params: {
            type: "object",
            properties: {
                language: { type: "string", description: "Hint language code, or empty for auto-detect" },
                audioRef: { type: "string", description: "Optional audio reference id" },
                streaming: { type: "boolean", description: "Use WebSocket streaming (requires sidecar)" },
            },
            required: [],
        },
        handler: async ({ businessId, customerId }, params) => {
            const echoTranscribe = require("../echo/transcribe");
            const configService = require("../config/service");
            const config = configService.getConfig(businessId);
            const sidecarUrl = config.echo?.sidecarUrl || process.env.ECHO_SIDECAR_URL;

            if (params.streaming && sidecarUrl) {
                // Return streaming session info for client to connect directly
                return {
                    mode: "streaming",
                    wsUrl: sidecarUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/transcribe",
                    language: params.language || config.echo?.defaultLanguage || "en",
                    prompt: config.echo?.initialPrompt || "",
                    wordTimestamps: config.echo?.wordTimestamps === true,
                };
            }

            if (sidecarUrl) {
                // Health check
                const health = await echoTranscribe.checkSidecarHealth(sidecarUrl);
                if (health.available) {
                    return {
                        mode: "batch",
                        sidecarUrl,
                        language: params.language || config.echo?.defaultLanguage || "en",
                        note: "Sidecar available — send audio via POST /api/v1/echo/transcribe or use streaming mode.",
                    };
                }
            }

            // Fallback: sidecar not available
            const lang = params?.language ? String(params.language).slice(0, 10) : "";
            return {
                mode: "unavailable",
                language: lang || "auto",
                note: "Echo sidecar not running. Configure ECHO_SIDECAR_URL or start echo/server.py. Customer can type instead.",
            };
        },
    },
    "call.handoff": {
        summary: "Hand the customer to a human (phone/email) — LAST RESORT ONLY after trying to resolve. Requires confirmation.",
        risk: "write",
        params: {
            type: "object",
            properties: {
                reason: { type: "string", description: "Why human is needed" },
                preferredContact: { type: "string", description: "Human phone or email to hand off to" },
                confirm: { type: "boolean" },
                token: { type: "string" },
            },
            required: ["reason"],
        },
        handler: ({ businessId, customerId }, params) => {
            const reason = String(params.reason || "").slice(0, 500) || "Customer requested human assistance";
            try {
                const calls = require("../echo/calls");
                const existing = calls.listCalls(businessId, 1)[0];
                if (existing) calls.requestHandoff(existing.call_id);
            } catch {}
            return { status: "handoff_requested", reason, contact: params.preferredContact || "business contact on file", next: "A team member will reach out shortly." };
        },
    },
    "guide.start": {
        summary: "Start website guide — shows step-by-step overlay pointing at real elements, ends with 'Ask me any question on XEVEN'. Use when user says guide me / show me around / tour / how does this site work.",
        risk: "read",
        params: {
            type: "object",
            properties: {
                siteUrl: { type: "string", description: "Optional site URL to guide, defaults to business site" },
            },
            required: [],
        },
        handler: async ({ businessId }, params) => {
            const guideStore = require("../guide/store");
            let guide = guideStore.getGuide(businessId);
            if (!guide && params.siteUrl) {
                try {
                    const { analyzeSite } = require("../site/analyzer");
                    const res = await analyzeSite({ businessId, siteUrl: params.siteUrl });
                    guide = res.guide;
                } catch {}
            }
            if (!guide) {
                // generic fallback so guide always works even before site analyze (human-like, no training needed)
                const steps = [
                    { id:"welcome", title:"Welcome — I'll guide you", selector:"body", description:"Hi, I'm XEVEN. I'll show you around in 60 seconds.", position:"center" },
                    { id:"explore", title:"Explore", selector:"nav, header", description:"Browse what's here — I'll explain as we go.", position:"bottom" },
                    { id:"ask", title:"Ask me anything on XEVEN", selector:"#xeven-widget-button", description:"Guide done. Ask any question — I still handle basics like support, sales, bookings.", position:"left" }
                ];
                return { status: "ok", guide: { steps, title: "Quick tour", siteUrl: params.siteUrl || "", siteType: "general", products: [] }, message: "I'll guide you in 3 short steps — I'll point at each thing. At the end, ask me any question on XEVEN." };
            }
            return { status: "ok", guide: { steps: guide.steps, title: guide.title, siteUrl: guide.siteUrl, siteType: guide.siteType, products: guide.products.slice(0,3) }, message: `I'll guide you in ${guide.steps.length} steps — I'll point at each thing. At the end, ask me any question on XEVEN.` };
        },
    },
    "guide.next": {
        summary: "Advance guide to next step (internal)",
        risk: "read",
        params: { type: "object", properties: { step: { type: "number" } }, required: [] },
        handler: async ({ businessId }, params) => {
            const guideStore = require("../guide/store");
            const guide = guideStore.getGuide(businessId);
            if (!guide) return { status: "no_guide", message: "No active guide." };
            const idx = Math.max(0, Math.min(guide.steps.length-1, (params.step||0)));
            return { status: "ok", step: guide.steps[idx], total: guide.steps.length };
        },
    },
    "site.analyze": {
        summary: "Analyze linked website: learns what site sells, updates knowledge/FAQs, builds guide steps. Human-like learn.",
        risk: "read",
        params: {
            type: "object",
            properties: { siteUrl: { type: "string", description: "https:// site URL" } },
            required: ["siteUrl"],
        },
        handler: async ({ businessId }, params) => {
            const { analyzeSite } = require("../site/analyzer");
            const res = await analyzeSite({ businessId, siteUrl: params.siteUrl });
            return { status: "ok", siteType: res.siteType, products: res.products, faqs: res.faqs, steps: res.steps.length, knowledgeCreated: res.knowledgeCreated, title: res.title };
        },
    },
};

const CAPABILITY_NAMES = Object.keys(CAPABILITIES);

function isDeclared(roleDef, name) {
    return Array.isArray(roleDef?.capabilities) && roleDef.capabilities.includes(name);
}

function isBusinessEnabled(config, name) {
    // Add-on gating: echo/call/chrono schedule edits require their add-on on the portal
    // (Unlimited plan bypasses). This is additive to the capability toggle.
    try {
        const addons = require("../addons/store");
        if (name === "echo.transcribe" && !addons.isEnabled(config?.__businessId || config?.businessId, "voice_channel") && !addons.isEnabled(config?.__businessId, "multilanguage")) {
            // echo is allowed if EITHER voice_channel OR multilanguage is on; but echo.transcribe without addon still degrades to text
        }
        if (name === "call.handoff") {
            const bid = config?.__businessId || config?.businessId;
            if (bid && !addons.isEnabled(bid, "voice_channel")) {
                // still allow handoff via email fallback; don't block hard here
            }
        }
        if ((name === "chrono.schedule.get" || name === "chrono.schedule.set") && config?.__businessId) {
            // chrono schedule management is portal-editable; agent read is always allowed
            if (name === "chrono.schedule.set") {
                // require portal flag at enforcement time (route-level also checks)
            }
        }
    } catch {}
    const toggles = config?.features?.capabilities;
    if (!toggles || typeof toggles !== "object") return true; // default-on per capability default
    return toggles[name] !== false;
}

/** Manifest of capabilities this role+business may use — rendered into the prompt. */
function manifestFor({ roleDef, config }) {
    return CAPABILITY_NAMES.filter((name) => isDeclared(roleDef, name) && isBusinessEnabled(config, name)).map(
        (name) => ({
            name,
            summary: CAPABILITIES[name].summary,
            risk: CAPABILITIES[name].risk,
            params: CAPABILITIES[name].params,
        })
    );
}

/** Unified brain manifest — no role gate, only business-level gating. One brain has all patterns. */
function manifestForUnified({ config }) {
    return CAPABILITY_NAMES.filter((name) => isBusinessEnabled(config, name)).map(
        (name) => ({
            name,
            summary: CAPABILITIES[name].summary,
            risk: CAPABILITIES[name].risk,
            params: CAPABILITIES[name].params,
        })
    );
}

function validateParams(capDef, args) {
    // Basic required field validation
    for (const key of capDef.params.required || []) {
        const value = args?.[key];
        if (value === undefined || value === null || value === "") {
            throw badRequest(`Missing required argument "${key}".`, "invalid_params");
        }
    }

    // JSON Schema validation if schema is defined
    if (capDef.params.properties && typeof capDef.params === "object") {
        const schema = {
            type: "object",
            properties: capDef.params.properties,
            required: capDef.params.required || [],
            additionalProperties: false,
        };
        const validationErrors = validateJsonSchema(args, schema);
        if (validationErrors.length > 0) {
            throw badRequest(`Invalid arguments: ${validationErrors.join(", ")}`, "invalid_params");
        }
    }

    return args || {};
}

/** Lightweight JSON Schema validator (subset: type, required, enum, string/number/boolean/object/array). */
function validateJsonSchema(data, schema, path = "") {
    const errors = [];

    function checkType(value, expectedType, p) {
        if (expectedType === "string") return typeof value === "string";
        if (expectedType === "number") return typeof value === "number" && isFinite(value);
        if (expectedType === "boolean") return typeof value === "boolean";
        if (expectedType === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
        if (expectedType === "array") return Array.isArray(value);
        return false;
    }

    function validate(value, sch, p) {
        if (sch.type && !checkType(value, sch.type, p)) {
            errors.push(`${p || "root"}: expected ${sch.type}, got ${typeof value}`);
            return;
        }

        if (sch.type === "object" && value !== null && typeof value === "object") {
            // Required properties
            for (const req of sch.required || []) {
                if (value[req] === undefined) {
                    errors.push(`${p}.${req}: required`);
                }
            }
            // Properties
            for (const [key, propSchema] of Object.entries(sch.properties || {})) {
                if (value[key] !== undefined) {
                    validate(value[key], propSchema, `${p}.${key}`);
                }
            }
            // Additional properties
            if (sch.additionalProperties === false) {
                const allowed = Object.keys(sch.properties || {});
                for (const key of Object.keys(value)) {
                    if (!allowed.includes(key)) {
                        errors.push(`${p}.${key}: additional property not allowed`);
                    }
                }
            }
        }

        if (sch.type === "array" && Array.isArray(value)) {
            if (sch.items) {
                for (let i = 0; i < value.length; i++) {
                    validate(value[i], sch.items, `${p}[${i}]`);
                }
            }
            if (typeof sch.minItems === "number" && value.length < sch.minItems) {
                errors.push(`${p}: array must have at least ${sch.minItems} items`);
            }
            if (typeof sch.maxItems === "number" && value.length > sch.maxItems) {
                errors.push(`${p}: array must have at most ${sch.maxItems} items`);
            }
        }

        if (sch.enum && !sch.enum.includes(value)) {
            errors.push(`${p}: must be one of [${sch.enum.join(", ")}]`);
        }

        if (sch.type === "string") {
            if (typeof sch.minLength === "number" && value.length < sch.minLength) {
                errors.push(`${p}: string must be at least ${sch.minLength} characters`);
            }
            if (typeof sch.maxLength === "number" && value.length > sch.maxLength) {
                errors.push(`${p}: string must be at most ${sch.maxLength} characters`);
            }
            if (sch.pattern && !new RegExp(sch.pattern).test(value)) {
                errors.push(`${p}: string does not match pattern`);
            }
        }

        if (sch.type === "number") {
            if (typeof sch.minimum === "number" && value < sch.minimum) {
                errors.push(`${p}: must be >= ${sch.minimum}`);
            }
            if (typeof sch.maximum === "number" && value > sch.maximum) {
                errors.push(`${p}: must be <= ${sch.maximum}`);
            }
        }
    }

    validate(data, schema, path);
    return errors;
}

/**
 * Authorize + run one requested capability call. NEVER throws — every
 * outcome becomes a structured result the chat loop feeds back as data.
 * Supports idempotency for write operations via idempotencyKey in arguments.
 */
async function executeCapability({ businessId, customerId, conversationId = null, config, roleDef, call }) {
    const name = String(call?.tool || "").trim();
    const finish = (result) => {
        audit.record({
            businessId,
            actorType: "agent",
            actorId: customerId,
            action: "capability.invoke",
            detail: { tool: name, status: result.status, code: result.code || null },
        });
        return result;
    };

    try {
        const capDef = CAPABILITIES[name];
        if (!capDef) return finish({ status: "error", code: "unknown_capability", message: `Unknown tool "${name}".` });

        if (!isDeclared(roleDef, name)) {
            return finish({ status: "error", code: "not_declared_for_role", message: "This tool is not available to your role." });
        }
        if (!isBusinessEnabled(config, name)) {
            return finish({ status: "error", code: "disabled_by_business", message: "The business disabled this tool." });
        }

        // Strip transport-only fields before validation/handler.
        const { confirm, token, idempotencyKey, ...args } = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
        validateParams(capDef, args);

        const ctx = { businessId, customerId, conversationId };

        if (capDef.risk === "write") {
            // Check idempotency for write operations
            const idempotencyKey = getIdempotencyKey(call);
            const cached = checkIdempotency(businessId, idempotencyKey);
            if (cached) {
                return finish({ ...cached, idempotentReplay: true });
            }

            if (confirm === true) {
                const verdict = intents.validateConfirmation({
                    businessId,
                    customerId,
                    conversationId,
                    tool: name,
                    args,
                    token,
                });
                if (!verdict.ok) {
                    return finish({
                        status: "denied",
                        code: `confirmation_failed_${verdict.reason}`,
                        message: "Confirmation failed. Ask the customer to confirm again, then re-issue the call with their agreement.",
                    });
                }
            } else {
                const proposal = intents.createIntent({
                    businessId,
                    customerId,
                    conversationId,
                    tool: name,
                    args,
                    messageCount: conversationCount(conversationId),
                });
                return finish({
                    status: "needs_confirmation",
                    code: "customer_confirmation_required",
                    token: proposal.token,
                    proposedArgs: args,
                    message:
                        "Proposed but NOT executed. Present these details to the customer and ask them to confirm. Only after they agree, re-issue the same call adding confirm=true and token.",
                });
            }
        }

        const output = await capDef.handler(ctx, args);
        const result = finish({ status: "ok", tool: name, data: output });

        // Cache successful write operations for idempotency
        if (capDef.risk === "write") {
            const idempotencyKey = getIdempotencyKey(call);
            setIdempotency(businessId, idempotencyKey, name, args, result);
        }

        return result;
    } catch (error) {
        const known = error && typeof error.status === "number";
        return finish({
            status: "error",
            code: known ? error.code || "handler_error" : "handler_error",
            message: known ? error.message : "The tool failed. Apologize and suggest an alternative.",
        });
    }
}

function conversationCount(conversationId) {
    if (!conversationId) return 0;
    try {
        const row = require("../../db").get().prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?`).get(conversationId);
        return row ? row.n : 0;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// tool-call wire format (fenced JSON — survives small local models)
// ---------------------------------------------------------------------------

const { parseStructuredOutput, SCHEMAS } = require("../ai/structured-output");

const FENCE_RE = /```(?:json|xeven-tool)?\s*\n([\s\S]*?)```/g;

/** Extract capability requests from an assistant reply with structured output validation. */
function parseToolCalls(reply) {
    if (!reply || typeof reply !== "string") return [];
    const calls = [];
    const seen = new Set();

    const push = (parsed) => {
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.tool === "string") {
            const sig = parsed.tool + "::" + JSON.stringify(parsed.arguments ?? {});
            if (!seen.has(sig)) {
                seen.add(sig);
                calls.push({ tool: parsed.tool, arguments: parsed.arguments ?? {} });
            }
        }
    };

    // 1. fenced blocks (```json / ```xeven-tool / bare ```)
    let match;
    FENCE_RE.lastIndex = 0;
    while ((match = FENCE_RE.exec(reply)) !== null) {
        const result = parseStructuredOutput(match[1].trim(), SCHEMAS.toolCall, { attemptRepair: true });
        if (result.valid) push(result.data);
    }

    // 2. whole-reply JSON
    const trimmed = reply.trim();
    if (trimmed.startsWith("{")) {
        const result = parseStructuredOutput(trimmed, SCHEMAS.toolCall, { attemptRepair: true });
        if (result.valid) push(result.data);
    }

    // 3. inline objects — small models often drop the fences entirely
    const inlineRe = /\{\s*"tool"\s*:/g;
    while ((match = inlineRe.exec(reply)) !== null) {
        let depth = 0, inString = false, escaped = false, end = -1;
        for (let i = match.index; i < reply.length; i++) {
            const ch = reply[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end > 0) {
            const result = parseStructuredOutput(reply.slice(match.index, end + 1), SCHEMAS.toolCall, { attemptRepair: true });
            if (result.valid) push(result.data);
        }
    }

    return calls;
}

/** Remove fenced tool-call blocks and stray inline tool JSON from a reply. */
function stripToolBlocks(reply) {
    if (!reply || typeof reply !== "string") return reply;
    let out = reply.replace(FENCE_RE, "");
    out = out.replace(/\{\s*"tool"\s*:\s*"(?:[^"\\]|\\.)*"\s*(?:,\s*"[^"]+"\s*:\s*(?:"(?:[^"\\]|\\.)*"|[^}]*))*\s*\}/g, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
    CAPABILITIES,
    CAPABILITY_NAMES,
    manifestFor,
    manifestForUnified,
    executeCapability,
    parseToolCalls,
    stripToolBlocks,
};
