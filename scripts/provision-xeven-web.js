"use strict";

/* One-time provisioning: wipe demo/test tenant data, create the Xeven Web
 * business, seed its knowledge from the marketing site content.
 * Run: node scripts/provision-xeven-web.js
 * Keeps: admin_users, meta (secrets!), schema_migrations.
 */

const dbm = require("../server/src/db");
dbm.init();
const db = require("../server/src/db").get;
const configService = require("../server/src/core/config/service");
const { createKnowledgeItem } = require("../server/src/core/knowledge/store");

const TENANT_TABLES = [
    "businesses", "business_configs", "customers", "memories",
    "behavioral_events", "business_knowledge", "conversations",
    "conversation_messages", "admin_business_access", "audit_log",
    "outcome_events", "feature_flags", "portal_users", "portal_settings",
    "follow_up_jobs", "email_log", "bookings", "capability_intents",
    "chrono_schedules", "chrono_overrides", "chrono_slot_holds",
    "business_addons", "echo_transcripts", "echo_voice_calls",
    "webhook_deliveries", "knowledge_embeddings", "tts_syntheses",
    "idempotency_keys", "memory_embeddings", "digest_schedule",
];

for (const t of TENANT_TABLES) {
    try {
        const r = db().prepare(`DELETE FROM "${t}"`).run();
        console.log(`wiped ${t}: ${r.changes}`);
    } catch (e) {
        console.log(`skip ${t}: ${e.message.slice(0, 80)}`);
    }
}

const created = configService.createBusiness({ businessId: "xeven_web", businessName: "Xeven" });
db().prepare("UPDATE businesses SET plan = 'unlimited' WHERE business_id = 'xeven_web'").run();
console.log("business:", created.business.businessId, created.business.businessName, "plan=unlimited");
console.log("STORE NOW — integration key shown once:");
console.log("  integrationKey:", created.integrationKey);
console.log("  widgetPublicKey:", created.widgetPublicKey);

const K = (title, knowledgeType, content, metadata) =>
    createKnowledgeItem({ businessId: "xeven_web", title, knowledgeType, content, metadata: metadata || {} });

K("What is Xeven", "info", "XEVEN — the AI employee for business websites. Chats 24/7, remembers shoppers, recovers carts, books with Chrono and talks with Echo. One snippet. 14-day free trial, cancel anytime.");
K("Instrument: Conversation", "info", "Situation, knowledge, memory and behavior fuse before a word is written. Tools act, handoff catches the edge. Proof: 12,408 this week.");
K("Instrument: Memory", "info", "Names, sizes, budgets, carts — per customer, recalled mid-sentence. Teach with “remember”, erase with “forget”. Proof: 38K facts held.");
K("Instrument: Chrono Booking", "info", "Chrono ranks real availability inside your hours, holds five minutes, confirms in two taps. Proof: 96 demos held.");
K("Instrument: Echo Voice", "info", "Widget mic and phone handoff, transcription plus natural voices — 100+ languages auto-detected. Proof: Echo mic + phone.");
K("Instrument: Verified Knowledge", "info", "Products and policies, searchable by keyword and meaning. XEVEN answers only from what it can verify. Proof: 0 invented prices.");
K("Telemetry: Hear", "info", "Every message read for intent, situation and history — not just keywords. (Telemetry 01 · Hear)");
K("Telemetry: Hold", "info", "Sizes, budgets, carts. Stored per customer, recalled mid-sentence. (Telemetry 02 · Hold)");
K("Telemetry: Answer", "info", "Grounded in your knowledge. Verified or silent — never invented. (Telemetry 03 · Answer)");
K("Telemetry: Earn", "info", "Slots held. Carts recovered. Browsers become buyers. (Telemetry 04 · Earn)");
K("Plan: Launch", "product", "Launch $29/mo + $99 setup. Includes: 1k conversations, 50 knowledge items, Widget + tracker, Memory + behavior. Excludes: Chrono booking, Echo voice, Custom rules. Yearly billing saves 20%, setup free.");
K("Plan: Growth", "product", "Growth $79/mo + $199 setup. Includes: 10k conversations, 200 knowledge items, Chrono booking, Echo English voice. Excludes: Voice channel, Multilanguage, Custom rules. Yearly billing saves 20%, setup free.");
K("Plan: Scale", "product", "Scale $199/mo + $499 setup. Includes: 50k conversations, 500 knowledge items, Chrono + Echo + Voice, Multilanguage, 10 custom rules. Yearly billing saves 20%, setup free.");
K("Plan: Custom", "product", "Custom from $499, bespoke setup. Includes: Unlimited everything, All add-ons included, Bespoke setup, Full analysis. Yearly billing saves 20%.");
K("Add-on: Voice Channel", "product", "Phone calls + widget mic. From $19/mo.");
K("Add-on: Multi-Language", "product", "Auto-detect chat; voice varies by provider. From $12/mo.");
K("Add-on: Custom Behaviour Pack", "product", "+5 rules on any plan. From $12/mo.");
K("Assistant skills", "info", "One widget, six trades: Support, Sales, Shopping, Advisor, Booking, Leads.");
K("Mission", "info", "Not just a widget. AI employee that changes business — not just a widget. Chats 24/7, remembers every shopper, recovers carts, books with Chrono and talks with Echo.");
K("Principle: Verified or silent", "info", "Grounded in your knowledge. Verified or silent — never invented.");
K("Principle: Live in a day", "info", "Fourteen days, $0 today, live in one day. Cancel in one click.");
K("Principle: One snippet", "info", "One snippet to install. Grounded answers only. Audited actions.");
K("Measured play", "info", "24/7 always on — nights, launches, holidays. 5-minute conflict-checked slot holds. 60-day booking window, best times first. Trust: one snippet to install, grounded answers only, audited actions, cancel in one click.");
K("Trial", "faq", "Fourteen days. $0 today. Live in one day. Cancel in one click.", { keywords: "trial price plan cancel free" });
K("Demo booking", "faq", "Thirty seconds. Then we talk shop. Pick a slot — held for 5 minutes, like Chrono does. Focus options: Revenue + bookings, Support at scale, Something bespoke.", { keywords: "demo booking slot trial" });
K("KB: Returns", "faq", "30-day returns, unused, receipt in email.", { keywords: "returns refund exchange" });
K("KB: Shipping", "faq", "Free over the threshold at checkout; tracked 2–5 days.", { keywords: "shipping delivery tracked" });
K("KB: Booking", "faq", "Ranked slots inside business hours; 5-minute holds; two-tap confirm.", { keywords: "booking appointment slot demo" });
K("KB: Trial", "faq", "14 days, $0 today, cancel in one click.", { keywords: "trial price plan cancel" });
K("KB: Voice", "faq", "Widget mic plus phone handoff; transcription and natural voices.", { keywords: "voice call phone echo" });

const n = db().prepare("SELECT COUNT(*) n FROM business_knowledge WHERE business_id='xeven_web'").get().n;
console.log(`knowledge seeded: ${n}`);
console.log("provision-ok");
