"use strict";

/**
 * Structured output validation and repair for AI responses.
 * Provides JSON schema validation, automatic repair, and type coercion.
 */

const { badRequest } = require("../../lib/errors");

/**
 * Parse and validate JSON from AI response with automatic repair.
 * @param {string} text - Raw AI response text
 * @param {Object} schema - JSON Schema to validate against
 * @param {Object} options - Repair options
 * @returns {Object} - { valid: boolean, data: any, errors: string[], repaired: boolean }
 */
function parseStructuredOutput(text, schema, options = {}) {
    const {
        attemptRepair = true,
        maxRepairAttempts = 2,
        strictMode = false,
    } = options;

    if (!text || typeof text !== "string") {
        return { valid: false, data: null, errors: ["Empty or invalid response"], repaired: false };
    }

    // Extract JSON from response (handle markdown code fences, etc.)
    let jsonStr = extractJSON(text);
    let repaired = false;

    for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
        try {
            const parsed = JSON.parse(jsonStr);
            const validationErrors = validateAgainstSchema(parsed, schema, "");
            
            if (validationErrors.length === 0) {
                return { valid: true, data: parsed, errors: [], repaired };
            }
            
            if (!attemptRepair || attempt === maxRepairAttempts) {
                return { valid: false, data: parsed, errors: validationErrors, repaired };
            }
            
            // Attempt repair
            jsonStr = repairJSON(jsonStr, validationErrors, schema);
            repaired = true;
            
        } catch (parseError) {
            if (!attemptRepair || attempt === maxRepairAttempts) {
                return { valid: false, data: null, errors: [parseError.message], repaired };
            }
            
            // Attempt repair for parse errors
            jsonStr = repairJSONParseError(jsonStr, parseError);
            repaired = true;
        }
    }

    return { valid: false, data: null, errors: ["Max repair attempts exceeded"], repaired };
}

/**
 * Extract JSON from text (handles code fences, prefixes, etc.)
 */
function extractJSON(text) {
    // Try fenced code blocks first
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) return fenceMatch[1].trim();

    // Try to find JSON object
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) return objMatch[0].trim();

    // Try to find JSON array
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) return arrMatch[0].trim();

    return text.trim();
}

/**
 * Validate parsed object against JSON Schema (subset).
 */
function validateAgainstSchema(data, schema, path = "") {
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
            // Per-tool argument validation: a toolCall envelope carrying a known
            // tool also enforces that tool's argument schema (e.g. booking.create
            // requires service + datetime, rejects unknown args).
            if (
                value.arguments !== undefined && value.arguments !== null &&
                typeof value.arguments === "object" && !Array.isArray(value.arguments) &&
                typeof value.tool === "string" && TOOL_ARG_SCHEMAS[value.tool]
            ) {
                validate(value.arguments, TOOL_ARG_SCHEMAS[value.tool], `${p}.arguments`);
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
 * Attempt to repair JSON string based on validation errors.
 */
function repairJSON(jsonStr, errors, schema) {
    let repaired = jsonStr;

    for (const error of errors) {
        // Handle missing required fields
        if (error.includes(": required")) {
            const field = error.split(":")[0].split(".").pop();
            const propSchema = schema.properties?.[field];
            if (propSchema) {
                const defaultValue = getDefaultValue(propSchema);
                const insertionPoint = findInsertionPoint(repaired, field);
                if (insertionPoint >= 0) {
                    repaired = repaired.slice(0, insertionPoint) + `"${field}": ${JSON.stringify(defaultValue)}, ` + repaired.slice(insertionPoint);
                }
            }
        }
        // Handle type mismatches
        else if (error.includes("expected string, got") || error.includes("expected number, got")) {
            const field = error.split(":")[0].split(".").pop();
            repaired = coerceType(repaired, field, error.includes("string") ? "string" : "number");
        }
    }

    return repaired;
}

/**
 * Attempt to repair JSON parse errors.
 */
function repairJSONParseError(jsonStr, parseError) {
    let repaired = jsonStr;

    // Common fixes
    // 1. Trailing commas
    repaired = repaired.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");

    // 2. Unquoted keys
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // 3. Single quotes to double quotes
    repaired = repaired.replace(/'([^']*)'/g, '"$1"');

    // 4. Remove comments
    repaired = repaired.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

    // 5. Fix unescaped newlines in strings
    repaired = repaired.replace(/"([^"]*)\n([^"]*)"/g, '"$1\\n$2"');

    return repaired;
}

/**
 * Coerce a field value to the expected type.
 */
function coerceType(jsonStr, field, targetType) {
    const regex = new RegExp(`"${field}"\\s*:\\s*([^,}]+)`, "g");
    return jsonStr.replace(regex, (match, value) => {
        const trimmed = value.trim();
        if (targetType === "string") {
            if (!trimmed.startsWith('"')) {
                return `"${field}": "${trimmed.replace(/"/g, '\\"')}"`;
            }
        } else if (targetType === "number") {
            const num = Number(trimmed);
            if (!isNaN(num)) {
                return `"${field}": ${num}`;
            }
        }
        return match;
    });
}

/**
 * Find insertion point for a missing field in JSON object.
 */
function findInsertionPoint(jsonStr, field) {
    const objEnd = jsonStr.lastIndexOf("}");
    if (objEnd > 0) {
        // Check if object is empty
        const objStart = jsonStr.indexOf("{");
        const content = jsonStr.slice(objStart + 1, objEnd).trim();
        if (!content) return objEnd;
        return objEnd;
    }
    return -1;
}

/**
 * Get default value for a schema property.
 */
function getDefaultValue(schema) {
    if (schema.default !== undefined) return schema.default;
    switch (schema.type) {
        case "string": return schema.enum ? schema.enum[0] : "";
        case "number": return schema.minimum || 0;
        case "boolean": return false;
        case "array": return [];
        case "object": return {};
        default: return null;
    }
}

/**
 * Predefined schemas for common AI outputs.
 */
const SCHEMAS = {
    toolCall: {
        type: "object",
        properties: {
            tool: { type: "string", minLength: 1 },
            arguments: { type: "object" },
        },
        required: ["tool", "arguments"],
        additionalProperties: false,
    },
    toolCallArray: {
        type: "array",
        items: {
            type: "object",
            properties: {
                tool: { type: "string", minLength: 1 },
                arguments: { type: "object" },
            },
            required: ["tool", "arguments"],
            additionalProperties: false,
        },
        minItems: 1,
    },
    bookingCreate: {
        type: "object",
        properties: {
            service: { type: "string", minLength: 1 },
            datetime: { type: "string", format: "date-time" },
            contact: { type: "string" },
            notes: { type: "string" },
            confirm: { type: "boolean" },
            token: { type: "string" },
        },
        required: ["service", "datetime"],
        additionalProperties: false,
    },
    sentiment: {
        type: "object",
        properties: {
            sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
            score: { type: "number", minimum: -1, maximum: 1 },
            keywords: { type: "array", items: { type: "string" } },
        },
        required: ["sentiment", "score"],
        additionalProperties: false,
    },
};

/**
 * Per-tool argument schemas enforced inside toolCall envelopes.
 * Keys are tool names as emitted by the model.
 */
const TOOL_ARG_SCHEMAS = {
    "booking.create": null, // wired below (SCHEMAS defined above)
};
TOOL_ARG_SCHEMAS["booking.create"] = SCHEMAS.bookingCreate;

module.exports = {
    parseStructuredOutput,
    validateAgainstSchema,
    repairJSON,
    repairJSONParseError,
    SCHEMAS,
};