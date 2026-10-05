"use strict";

/**
 * BX shared-brain manifest, generated from the capability registry so the
 * brain's view of the body can never drift from what executeCapability does.
 * Names match bx/bodies/manifests.py XEVEN_MANIFEST verbatim (no translation).
 */

const capabilities = require("../capabilities");

function buildManifest({ businessId = "xeven", bodyType = "business_ai" } = {}) {
    const defs = capabilities.CAPABILITIES || {};
    const caps = Object.entries(defs)
        .filter(([, def]) => def && typeof def.summary === "string")
        .map(([name, def]) => {
            const cap = { name, description: def.summary, risk: def.risk || "read" };
            if (cap.risk === "write") cap.requires_confirmation = true;
            return cap;
        })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    return {
        body_id: businessId === "xeven_web" ? "xeven" : String(businessId || "xeven"),
        body_type: bodyType,
        capabilities: caps,
        permissions: {},
        interfaces: ["chat", "widget", "voice"],
    };
}

module.exports = { buildManifest };
