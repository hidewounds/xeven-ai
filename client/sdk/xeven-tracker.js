// ============================================================
// XEVEN TRACKER — website behavioral tracking SDK
//
// Usage:
//   <script src="https://your-xeven-host/widget/xeven-tracker.js"
//           data-public-key="xeven_pk_xxx"
//           data-api="https://your-xeven-host"
//           defer></script>
//
//   XevenTracker.productView({ productId: "42", productName: "Sneaker", price: 99 })
//   XevenTracker.search({ query: "running shoes" })
//   XevenTracker.cart({ action: "add", productId: "42" })
//   XevenTracker.purchase({ orderId: "A1", total: 149 })
// ============================================================

(function (global) {
    "use strict";

    var currentScript =
        document.currentScript ||
        (function () {
            var scripts = document.getElementsByTagName("script");
            return scripts[scripts.length - 1];
        })();

    var DEFAULT_API = "/api/v1/behavior";
    var apiKey = currentScript ? currentScript.getAttribute("data-public-key") || "" : "";
    var apiBase = currentScript ? (currentScript.getAttribute("data-api") || "").replace(/\/+$/, "") : "";
    if (!apiBase && currentScript && currentScript.src) {
        try {
            // Derive the server origin from the script URL so tracking also
            // works when the host page runs from file:// or a different origin.
            apiBase = new URL(currentScript.src, window.location.href).origin;
        } catch (e) {
            apiBase = "";
        }
    }
    var apiUrl = DEFAULT_API;
    var enabled = true;

    function configure(options) {
        options = options || {};
        if (typeof options.apiKey === "string") apiKey = options.apiKey.trim();
        if (typeof options.apiUrl === "string" && options.apiUrl.trim()) apiUrl = options.apiUrl.trim();
        if (typeof options.enabled === "boolean") enabled = options.enabled;
        return status();
    }

    function getVisitorId() {
        try {
            var id = localStorage.getItem("xeven_visitor_id");
            if (id) return id;
            id = "visitor_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem("xeven_visitor_id", id);
            return id;
        } catch (e) {
            return "anonymous";
        }
    }

    /** Identify the visitor as a known customer (call after your own login). */
    function identify(customerId) {
        try {
            if (customerId) {
                sessionStorage.setItem("xeven_customer_id", String(customerId));
            } else {
                sessionStorage.removeItem("xeven_customer_id");
            }
        } catch (e) {
            /* ignore */
        }
    }

    // Last purchase-intent signal — the widget's proactive trigger reads this.
    var lastIntentSignal = null;
    function rememberIntent(eventType, eventData) {
        if (["cart", "wishlist", "product_view"].indexOf(eventType) === -1) return;
        var label = "";
        if (eventType === "cart") {
            var items = (eventData && eventData.items) || [];
            label = items.length
                ? "your cart (" + items.map(function (i) { return i.name || i.sku || "item"; }).slice(0, 2).join(", ") + (items.length > 2 ? "…" : "") + ")"
                : "the items you picked";
        } else if (eventData && eventData.productName) {
            label = "the " + eventData.productName;
        } else if (eventData && eventData.name) {
            label = "the " + eventData.name;
        } else {
            label = eventType === "product_view" ? "this product" : "what you were looking at";
        }
        lastIntentSignal = {
            type: eventType,
            message:
                eventType === "product_view"
                    ? "Questions about " + label + "? I'm here to help."
                    : "Still thinking about " + label + "? I can help you decide or answer anything.",
            at: Date.now(),
        };
        try {
            document.dispatchEvent(new CustomEvent("xeven:intent", { detail: lastIntentSignal }));
        } catch (e) { /* older browsers */ }
    }

    async function track(eventType, eventData) {
        if (!enabled) return { saved: false, reason: "tracking_disabled" };
        if (!apiKey) {
            console.warn("XEVEN Tracker: missing API key.");
            return { saved: false, reason: "missing_key" };
        }
        if (typeof eventType !== "string" || !eventType.trim()) {
            return { saved: false, reason: "invalid_event_type" };
        }

        try {
            rememberIntent(eventType, eventData);

            var response = await fetch(apiBase + apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-xeven-key": apiKey },
                body: JSON.stringify({
                    customerId:
                        (function () {
                            try {
                                return sessionStorage.getItem("xeven_customer_id");
                            } catch (e) {
                                return null;
                            }
                        })() || getVisitorId(),
                    eventType: eventType.trim(),
                    eventData: eventData && typeof eventData === "object" ? eventData : {}
                })
            });

            if (!response.ok) {
                var data = {};
                try {
                    data = await response.json();
                } catch (e) {
                    /* ignore */
                }
                console.warn("XEVEN Tracker failed:", response.status, data);
                return { saved: false, status: response.status };
            }
            return await response.json().catch(function () {
                return { saved: true };
            });
        } catch (error) {
            // Tracking must never break the host website.
            console.warn("XEVEN Tracker network error:", error.message);
            return { saved: false, error: error.message };
        }
    }

    // -------------------------------------------------------
    // semantic helpers
    // -------------------------------------------------------

    var tracker = {
        configure: configure,
        identify: identify,
        track: track,

        /** Last purchase-intent signal, for the widget's proactive trigger. */
        lastIntent: function () {
            return lastIntentSignal;
        },

        pageView: function (metadata) {
            return track("page_view", Object.assign({ url: location.pathname, referrer: document.referrer || null }, metadata || {}));
        },

        productView: function (options) {
            options = options || {};
            return track("product_view", {
                productId: options.productId ?? null,
                productName: options.productName ?? null,
                price: options.price ?? null,
                category: options.category ?? null
            });
        },

        search: function (options) {
            options = typeof options === "string" ? { query: options } : options || {};
            return track("search", { query: String(options.query || "").slice(0, 300), resultsCount: options.resultsCount ?? null });
        },

        categoryView: function (options) {
            options = typeof options === "string" ? { categoryName: options } : options || {};
            return track("category_view", {
                categoryId: options.categoryId ?? null,
                categoryName: options.categoryName ?? null
            });
        },

        cart: function (options) {
            options = options || {};
            return track("cart", {
                action: options.action || "add",
                productId: options.productId ?? null,
                productName: options.productName ?? null,
                quantity: options.quantity ?? 1,
                price: options.price ?? null
            });
        },

        wishlist: function (options) {
            options = options || {};
            return track("wishlist", {
                action: options.action || "add",
                productId: options.productId ?? null,
                productName: options.productName ?? null
            });
        },

        purchase: function (options) {
            options = options || {};
            return track("purchase", {
                orderId: options.orderId ?? null,
                total: options.total ?? null,
                currency: options.currency ?? null,
                items: Array.isArray(options.items) ? options.items.slice(0, 50) : []
            });
        },

        enable: function () {
            enabled = true;
            return true;
        },

        disable: function () {
            enabled = false;
            return true;
        }
    };

    function status() {
        return { enabled: enabled, apiUrl: apiUrl, configured: Boolean(apiKey), identified: hasIdentity() };
    }

    function hasIdentity() {
        try {
            return Boolean(sessionStorage.getItem("xeven_customer_id"));
        } catch (e) {
            return false;
        }
    }

    global.XevenTracker = tracker;

    // Auto-track a page view when configured via script attributes.
    if (currentScript && currentScript.getAttribute("data-auto-pageview") !== "false") {
        if (document.readyState === "complete") {
            setTimeout(function () {
                tracker.pageView();
            }, 0);
        } else {
            window.addEventListener("load", function () {
                tracker.pageView();
            });
        }
    }
})(window);

/* COMPAT (pre-rebrand embeds): old global keeps working. Remove once embeds migrate. */
try { if (typeof globalThis !== "undefined" && globalThis.XevenTracker && !globalThis.NOVATracker) { globalThis.NOVATracker = globalThis.XevenTracker; } } catch (e) {}
