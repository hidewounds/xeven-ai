"use strict";
/* Provision PRODUCTION xeven-ai over HTTP: login, ensure xeven_web business,
 * seed missing knowledge, (re)create portal user, verify widget.
 * Run: node scripts/provision-prod.js
 * Env: PROD_BASE (default https://xeven-ai-hidewounds-9658.vercel.app)
 *      ADMIN_EMAIL, ADMIN_PASS
 */
const crypto = require("crypto");

const BASE = process.env.PROD_BASE || "https://xeven-ai-hidewounds-9658.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_EMAIL || !ADMIN_PASS) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASS env vars (never commit credentials).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

const KNOWLEDGE = [
  ["What is Xeven", "info", "XEVEN — the AI employee for business websites. Chats 24/7, remembers shoppers, recovers carts, books with Chrono and talks with Echo. One snippet. 14-day free trial, cancel anytime."],
  ["Instrument: Conversation", "info", "Situation, knowledge, memory and behavior fuse before a word is written. Tools act, handoff catches the edge. Proof: 12,408 this week."],
  ["Instrument: Memory", "info", "Names, sizes, budgets, carts — per customer, recalled mid-sentence. Teach with \u201cremember\u201d, erase with \u201cforget\u201d. Proof: 38K facts held."],
  ["Instrument: Chrono Booking", "info", "Chrono ranks real availability inside your hours, holds five minutes, confirms in two taps. Proof: 96 demos held."],
  ["Instrument: Echo Voice", "info", "Widget mic and phone handoff, transcription plus natural voices — 100+ languages auto-detected. Proof: Echo mic + phone."],
  ["Instrument: Verified Knowledge", "info", "Products and policies, searchable by keyword and meaning. XEVEN answers only from what it can verify. Proof: 0 invented prices."],
  ["Telemetry: Hear", "info", "Every message read for intent, situation and history — not just keywords. (Telemetry 01 · Hear)"],
  ["Telemetry: Hold", "info", "Sizes, budgets, carts. Stored per customer, recalled mid-sentence. (Telemetry 02 · Hold)"],
  ["Telemetry: Answer", "info", "Grounded in your knowledge. Verified or silent — never invented. (Telemetry 03 · Answer)"],
  ["Telemetry: Earn", "info", "Slots held. Carts recovered. Browsers become buyers. (Telemetry 04 · Earn)"],
  ["Plan: Launch", "product", "Launch $29/mo + $99 setup. Includes: 1k conversations, 50 knowledge items, Widget + tracker, Memory + behavior. Excludes: Chrono booking, Echo voice, Custom rules. Yearly billing saves 20%, setup free."],
  ["Plan: Growth", "product", "Growth $79/mo + $199 setup. Includes: 10k conversations, 200 knowledge items, Chrono booking, Echo English voice. Excludes: Voice channel, Multilanguage, Custom rules. Yearly billing saves 20%, setup free."],
  ["Plan: Scale", "product", "Scale $199/mo + $499 setup. Includes: 50k conversations, 500 knowledge items, Chrono + Echo + Voice, Multilanguage, 10 custom rules. Yearly billing saves 20%."],
  ["Plan: Custom", "product", "Custom from $499, bespoke setup. Includes: Unlimited everything, All add-ons included, Bespoke setup, Full analysis. Yearly billing saves 20%."],
  ["Add-on: Voice Channel", "product", "Phone calls + widget mic. From $19/mo."],
  ["Add-on: Multi-Language", "product", "Auto-detect chat; voice varies by provider. From $12/mo."],
  ["Add-on: Custom Behaviour Pack", "product", "+5 rules on any plan. From $12/mo."],
  ["Assistant skills", "info", "One widget, six trades: Support, Sales, Shopping, Advisor, Booking, Leads."],
  ["Mission", "info", "Not just a widget. AI employee that changes business — not just a widget. Chats 24/7, remembers every shopper, recovers carts, books with Chrono and talks with Echo."],
  ["Principle: Verified or silent", "info", "Grounded in your knowledge. Verified or silent — never invented."],
  ["Principle: Live in a day", "info", "Fourteen days, $0 today, live in one day. Cancel in one click."],
  ["Principle: One snippet", "info", "One snippet to install. Grounded answers only. Audited actions."],
  ["Measured play", "info", "24/7 always on — nights, launches, holidays. 5-minute conflict-checked slot holds. 60-day booking window, best times first. Trust: one snippet to install, grounded answers only, audited actions, cancel in one click."],
  ["Trial", "faq", "Fourteen days. $0 today. Live in one day. Cancel in one click."],
  ["Demo booking", "faq", "Thirty seconds. Then we talk shop. Pick a slot — held for 5 minutes, like Chrono does. Focus options: Revenue + bookings, Support at scale, Something bespoke."],
  ["KB: Returns", "faq", "30-day returns, unused, receipt in email."],
  ["KB: Shipping", "faq", "Free over the threshold at checkout; tracked 2–5 days."],
  ["KB: Booking", "faq", "Ranked slots inside business hours; 5-minute holds; two-tap confirm."],
  ["KB: Trial", "faq", "14 days, $0 today, cancel in one click."],
  ["KB: Voice", "faq", "Widget mic plus phone handoff; transcription and natural voices."],
];

(async () => {
  // 1. login, else register (fresh ephemeral DB)
  let login = await api("POST", "/api/admin/auth/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASS });
  console.log("login:", login.status);
  if (login.status !== 200) {
    console.log("login failed, trying register (fresh DB?)");
    const reg = await api("POST", "/api/admin/auth/register", null, { email: ADMIN_EMAIL, password: ADMIN_PASS });
    console.log("register:", reg.status, JSON.stringify(reg.data).slice(0, 200));
    if (reg.status !== 201) { console.log("FATAL: cannot authenticate"); process.exit(1); }
    login = { status: 200, data: reg.data };
  }
  const token = login.data.accessToken;
  console.log("admin:", login.data.admin && login.data.admin.email, "super:", login.data.admin && login.data.admin.isSuper);

  // 2. businesses
  const bl = await api("GET", "/api/admin/businesses", token);
  console.log("businesses:", bl.status, JSON.stringify((bl.data.businesses || []).map((b) => b.businessId || b.business_id)));
  let biz = (bl.data.businesses || []).find((b) => (b.businessId || b.business_id) === "xeven_web");
  let pubKey = null, secKey = null;
  if (!biz) {
    const c = await api("POST", "/api/admin/businesses", token, { businessId: "xeven_web", businessName: "Xeven" });
    console.log("create business:", c.status);
    if (c.status !== 201) { console.log("FATAL:", JSON.stringify(c.data).slice(0, 400)); process.exit(1); }
    pubKey = c.data.widgetPublicKey; secKey = c.data.integrationKey;
    console.log("NEW KEYS ISSUED (store now)");
    const p = await api("PATCH", "/api/admin/businesses/xeven_web", token, { plan: "unlimited" });
    console.log("plan unlimited:", p.status);
  } else {
    console.log("xeven_web exists already");
  }

  // 3. knowledge — post only missing titles
  const kl = await api("GET", "/api/admin/businesses/xeven_web/knowledge", token);
  const existing = new Set(((kl.data && (kl.data.items || kl.data.knowledge)) || []).map((k) => k.title));
  console.log("existing knowledge:", existing.size);
  let added = 0;
  for (const [title, knowledgeType, content] of KNOWLEDGE) {
    if (existing.has(title)) continue;
    const r = await api("POST", "/api/admin/businesses/xeven_web/knowledge", token, { title, knowledgeType, content });
    if (r.status === 201) { added++; } else { console.log("knowledge FAIL", title, r.status, JSON.stringify(r.data).slice(0, 150)); }
    await sleep(250);
  }
  console.log("knowledge added:", added);

  // 4. portal user (creates or resets)
  const portalPass = "Xv-" + crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) + "-2026";
  const pu = await api("POST", "/api/admin/businesses/xeven_web/portal-users", token, { email: "portal@xeven.world", password: portalPass });
  console.log("portal user:", pu.status, JSON.stringify(pu.data).slice(0, 200));

  // 5. resolve public key + verify widget
  if (!pubKey) {
    const bd = await api("GET", "/api/admin/businesses/xeven_web", token);
    pubKey = bd.data && (bd.data.business.widgetPublicKey || bd.data.business.widget_public_key);
    console.log("business detail:", bd.status);
  }
  console.log("PUBLIC KEY:", pubKey);
  const cfg = await fetch(BASE + "/api/v1/widget/config", { headers: { "x-xeven-key": pubKey } });
  console.log("widget/config:", cfg.status);
  const chat = await fetch(BASE + "/api/v1/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-xeven-key": pubKey }, body: JSON.stringify({ message: "How much is Growth?" }) });
  const chatText = await chat.text();
  console.log("chat:", chat.status, chatText.slice(0, 300));

  console.log(JSON.stringify({ publicKey: pubKey, secretKey: secKey, portalPass, chatStatus: chat.status }));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
