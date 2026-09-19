"use strict";
/**
 * Site Analyzer — human-like learn then operate.
 * When agent is linked to a website, it:
 * 1. Fetches the site (and linked pages) — understands structure, what is sold
 * 2. Extracts products, FAQs, policies, navigation — updates Knowledge & FAQs
 * 3. Generates guide_steps with selectors for pointer overlay
 * Uses only native fetch + regex (Vercel-safe, no cheerio).
 */

const knowledgeStore = require("../knowledge/store");
const db = require("../../db").get;

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "XEVEN-Analyzer/1.0" } });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

function stripTags(s) { return String(s||"").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, "i");
  const m = html.match(re); if (m) return stripTags(m[1]);
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, "i");
  const m2 = html.match(re2); return m2 ? stripTags(m2[1]) : "";
}
function extractTitle(html) { const m = html.match(/<title[^>]*>([^<]+)<\/title>/i); return m ? stripTags(m[1]) : ""; }

function extractProducts(html) {
  const products = [];
  // heuristic: look for product-like blocks with price $/₹/€
  const priceRe = /(?:\$|₹|€)\s?\d+(?:[.,]\d+)?/g;
  // find headings near prices
  const blocks = html.split(/<div|<section|<article|<li/i).slice(0,120);
  for (const b of blocks) {
    const priceM = b.match(priceRe);
    if (!priceM) continue;
    // get heading/text before price
    const text = stripTags(b).slice(0, 400);
    if (text.length < 15 || text.length > 300) continue;
    // likely product if contains common commerce words or short title before price
    const title = text.split(priceM[0])[0].trim().split(/\s+/).slice(-8).join(" ").slice(0,80);
    if (title.length < 3) continue;
    products.push({ title: title || text.slice(0,60), price: priceM[0], snippet: text.slice(0,220) });
    if (products.length >= 12) break;
  }
  // dedupe by title
  const seen = new Set();
  return products.filter(p => { const k = p.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0,10);
}

function extractFaqs(html) {
  const faqs = [];
  // look for FAQ / accordion / details
  const faqSectionRe = /<(?:div|section)[^>]*class="[^"]*faq[^"]*"[^>]*>([\s\S]{0,3000})<\/(?:div|section)>/gi;
  let m;
  while ((m = faqSectionRe.exec(html)) && faqs.length < 8) {
    const sec = m[1];
    const qRe = /<[^>]*>([^<]{10,120}\?)<\/[^>]*>\s*<[^>]*>([^<]{20,400})<\/[^>]*>/g;
    let qm;
    while ((qm = qRe.exec(sec)) && faqs.length < 8) {
      faqs.push({ q: stripTags(qm[1]).slice(0,120), a: stripTags(qm[2]).slice(0,350) });
    }
  }
  // fallback: Q? A pattern via details/summary
  if (!faqs.length) {
    const detailRe = /<summary[^>]*>([^<]+)<\/summary>\s*([^<]{20,400})/gi;
    while ((m = detailRe.exec(html)) && faqs.length < 6) {
      faqs.push({ q: stripTags(m[1]).slice(0,120), a: stripTags(m[2]).slice(0,350) });
    }
  }
  return faqs;
}

function inferSiteType(html, url) {
  const t = (extractTitle(html) + " " + html.slice(0,5000)).toLowerCase();
  if (/shop|cart|product|price|checkout|buy now|add to cart/.test(t)) return "ecommerce";
  if (/book|appointment|schedule|calendar|slot/.test(t)) return "booking";
  if (/restaurant|menu|order|delivery/.test(t)) return "restaurant";
  if (/real estate|property|listing/.test(t)) return "realestate";
  return "general";
}

async function extractTheme(html, siteUrl) {
  // deeper UI improvisation — widget learns design system so it sits well with site
  const theme = {
    primary: null,
    secondary: null,
    background: null,
    surface: null,
    text: null,
    muted: null,
    border: null,
    fontFamily: null,
    headingFont: null,
    radius: null,
    radiusLg: null,
    shadow: null,
    spacing: null,
    darkMode: null,
    customerBase: null,
    updatedAt: Date.now(),
    siteUrl,
  };
  // restricted: never learn from admin/login/checkout with sensitive inputs
  const lower = html.toLowerCase();
  const isRestricted = /\/admin|\/login|\/checkout.*password|\/portal/.test(lower) && /type=.password/i.test(html);
  if (isRestricted) {
    // skip sensitive — return minimal theme without learning restricted content
    return { ...theme, restricted: true, note: "skipped restricted" };
  }
  // primary color: meta theme-color > css variable --violet --primary > first hex in <style>
  const metaTheme = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i);
  if (metaTheme) theme.primary = metaTheme[1].trim();
  if (!theme.primary) {
    const cssVars = html.match(/--(?:primary|violet|accent|brand)[^:]*:\s*([^;\s]+)/i);
    if (cssVars) theme.primary = cssVars[1].trim();
  }
  if (!theme.primary) {
    const hexes = html.match(/#[0-9a-f]{3,6}\b/gi);
    // pick most frequent hex that's not bg/white/black — brand is usually violet #8b5cf6
    if (hexes) {
      const freq = {};
      const skip = { "#fff":1, "#ffffff":1, "#000":1, "#000000":1, "#050508":1, "#080a14":1, "#0b0e1a":1, "#0f1221":1, "#f1f5f9":1 };
      hexes.forEach(function (h) {
        const c = h.toLowerCase();
        if (skip[c]) return;
        // skip too light/dark desaturated
        freq[c] = (freq[c] || 0) + 1;
      });
      let best = null, bestCount = 0;
      for (const k in freq) if (freq[k] > bestCount) { bestCount = freq[k]; best = k; }
      if (best) theme.primary = best;
    }
  }
  // fetch linked CSS for brand color if still not found (fetch xeven.css)
  if (!theme.primary || theme.primary === "#050508") {
    try {
      const cssUrl = new URL("/xeven.css", siteUrl).toString();
      // try fetch css — best effort, ignore errors
      const cssText = await fetchWithTimeout(cssUrl, 4000).catch(function(){ return ""; });
      if (cssText) {
        const m = cssText.match(/--violet[^:]*:\s*([^;\s]+)/i) || cssText.match(/--primary[^:]*:\s*([^;\s]+)/i);
        if (m) theme.primary = m[1].trim();
        if (!theme.primary || theme.primary === "#050508") {
          const hex2 = cssText.match(/#8b5cf6|#6366f1|#a78bfa/gi);
          if (hex2 && hex2[0]) theme.primary = hex2[0];
        }
      }
    } catch {}
  }
  if (!theme.primary) theme.primary = siteUrl && siteUrl.includes("xeven") ? "#8b5cf6" : "#6366f1";
  // deeper UI — background, surface, text, muted, border, fonts, radius, shadow, spacing, dark/light
  const bgMatch = html.match(/body[^}]*background[^:]*:\s*([^;}\n]+)/i) || html.match(/--bg[^:]*:\s*([^;\s]+)/i);
  if (bgMatch) theme.background = bgMatch[1].trim().slice(0, 30);
  // try fetch CSS for deeper tokens (only if siteUrl available)
  let cssText = "";
  try {
    const cssUrl = new URL("/xeven.css", siteUrl).toString();
    cssText = await fetchWithTimeout(cssUrl, 3500).catch(function(){ return ""; }) || "";
  } catch {}
  const combined = html + "\n" + cssText;
  // secondary / accent
  const secMatch = combined.match(/--(?:secondary|cyan|blue)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i);
  if (secMatch) theme.secondary = secMatch[1].trim().slice(0, 20);
  const surfMatch = combined.match(/--surface\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i) || combined.match(/--surface-2\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i);
  if (surfMatch) theme.surface = surfMatch[1].trim().slice(0, 30);
  const textMatch = combined.match(/--text\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i);
  if (textMatch) theme.text = textMatch[1].trim().slice(0, 20);
  const mutedMatch = combined.match(/--mut\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i);
  if (mutedMatch) theme.muted = mutedMatch[1].trim().slice(0, 20);
  const borderMatch = combined.match(/--line\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\)|[a-z]+)/i);
  if (borderMatch) theme.border = borderMatch[1].trim().slice(0, 30);
  // fonts — heading vs body
  const fontMatch = combined.match(/font-family\s*:\s*([^;}\n]+)/i);
  if (fontMatch) theme.fontFamily = stripTags(fontMatch[1]).split(",")[0].replace(/['"]/g, "").trim().slice(0, 30);
  const headingFontMatch = combined.match(/h1[^}]*font-family[^:]*:\s*([^;}\n]+)/i) || combined.match(/--heading[^:]*:\s*([^;\s]+)/i);
  if (headingFontMatch) theme.headingFont = stripTags(headingFontMatch[1]).split(",")[0].replace(/['"]/g, "").trim().slice(0, 30);
  // radius
  const radiusMatch = combined.match(/border-radius\s*:\s*([^;\s]+)/i) || combined.match(/--r[^:]*:\s*([^;\s]+)/i);
  if (radiusMatch) theme.radius = radiusMatch[1].trim().slice(0, 12);
  const radiusLgMatch = combined.match(/--r-lg[^:]*:\s*([^;\s]+)/i);
  if (radiusLgMatch) theme.radiusLg = radiusLgMatch[1].trim().slice(0, 12);
  // shadow
  const shadowMatch = combined.match(/--shadow[^:]*:\s*([^;]+);/i) || combined.match(/box-shadow\s*:\s*([^;}\n]+)/i);
  if (shadowMatch) theme.shadow = shadowMatch[1].trim().slice(0, 60);
  // spacing
  const gapMatch = combined.match(/gap\s*:\s*([^;\s]+)/i) || combined.match(/--gap[^:]*:\s*([^;\s]+)/i);
  if (gapMatch) theme.spacing = gapMatch[1].trim().slice(0, 12);
  // darkMode — site is dark if bg is #050508 or dark
  theme.darkMode = /#050508|#080a14|#0b0e1a|background:\s*#0|dark/i.test(combined.slice(0,5000)) ? true : false;
  // customer base inference — who site serves, not restricted personal data
  const text = stripTags(html).toLowerCase().slice(0, 8000);
  if (/shoe|fashion|apparel|sneaker/.test(text)) theme.customerBase = "fashion shoppers — size, budget, style";
  else if (/saas|platform|ai employee|subscription/.test(text)) theme.customerBase = "business owners — efficiency, ROI, trials";
  else if (/restaurant|food|menu/.test(text)) theme.customerBase = "diners — time, location, cravings";
  else if (/booking|appointment|consult/.test(text)) theme.customerBase = "clients — time slots, urgency";
  else theme.customerBase = "general visitors — curiosity, quick answers";
  // never store restricted personal data, only aggregated style
  return theme;
}

function inferCustomerBase(html) {
  const t = stripTags(html).toLowerCase();
  if (/shoe|sneaker|fashion/.test(t)) return "fashion";
  if (/saas|ai employee|platform/.test(t)) return "business";
  return "general";
}

function buildGuideSteps({ siteUrl, siteType, html }) {
  const steps = [];
  const has = (sel) => {
    // cheap selector existence heuristic: check html contains class/id/tag
    const key = sel.replace(/[^\w-]/g, "").toLowerCase();
    return html.toLowerCase().includes(key) || html.includes(sel.replace(/^[a-z]+\./,""));
  };
  // Step 1: welcome
  steps.push({ id: "welcome", title: "Welcome — I'll guide you", selector: "body", description: "Hi, I'm XEVEN. I'll show you around in 60 seconds.", position: "center" });
  if (siteType === "ecommerce") {
    // nav/products
    steps.push({ id: "products", title: "Browse what's sold", selector: has(".product") ? ".product" : (has("main") ? "main" : "body"), description: "These are the products we have live. Tap any to see details.", position: "bottom" });
    steps.push({ id: "product-detail", title: "See details & price", selector: has(".product-card") ? ".product-card" : ".product", description: "Price, specs and photos are verified from our catalog.", position: "top" });
    steps.push({ id: "cart", title: "Add to cart", selector: has("add to cart") ? "button:contains('Add to cart'), .add-to-cart, [data-add-to-cart]" : "button", description: "Click Add to cart — I'll remember your choice.", position: "top" });
    steps.push({ id: "checkout", title: "Checkout", selector: has("checkout") ? "a[href*='checkout'], a[href*='cart'], button:contains('Checkout')" : "a[href*='cart']", description: "Review cart and checkout securely.", position: "top" });
  } else if (siteType === "booking") {
    steps.push({ id: "availability", title: "Check availability", selector: has("calendar") ? ".calendar, [data-availability], #xeven-avail-toggle" : "body", description: "See live slots — updates in <1s.", position: "bottom" });
    steps.push({ id: "book", title: "Book a slot", selector: has("book") ? "button:contains('Book'), .xeven-slot" : "button", description: "Pick a time, confirm, and I'll book it with confirmation.", position: "top" });
  } else {
    steps.push({ id: "explore", title: "Explore", selector: has("nav") ? "nav" : "header", description: "Start here — I'll explain each section.", position: "bottom" });
    steps.push({ id: "cta", title: "Take action", selector: has("button") ? "button, a.btn, a[href*='contact']" : "body", description: "Ready to get started? Click the main action.", position: "top" });
  }
  steps.push({ id: "ask", title: "Ask me anything on XEVEN", selector: "#xeven-widget-button, #xeven-widget", description: "Guide done. Ask me any question on XEVEN — I now know your site and what's sold.", position: "left" });
  // normalize selectors for overlay (fallback to body if not found)
  return steps.map((s, i) => ({ ...s, order: i+1 }));
}

async function analyzeSite({ businessId, siteUrl }) {
  if (!businessId) throw new Error("businessId required");
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) throw new Error("Valid siteUrl (https://) required");
  const html = await fetchWithTimeout(siteUrl);
  const title = extractTitle(html);
  const description = extractMeta(html, "description") || stripTags(html).slice(0, 300);
  const siteType = inferSiteType(html, siteUrl);
  const products = extractProducts(html);
  const faqs = extractFaqs(html);

  // 1. Update knowledge — learn what's sold (human-like)
  const created = [];
  const seenTitles = new Set(knowledgeStore.listKnowledge(businessId).items?.map(k=>k.title.toLowerCase()) || knowledgeStore.listKnowledge(businessId).map?.(k=>k.title.toLowerCase()) || []);
  // Add site overview knowledge
  const overviewTitle = `${title || new URL(siteUrl).hostname} — overview`;
  if (!seenTitles.has(overviewTitle.toLowerCase())) {
    try {
      const item = knowledgeStore.createKnowledgeItem({ businessId, title: overviewTitle, knowledgeType: "info", content: description.slice(0,900) || `Official site: ${siteUrl}. ${siteType} site analyzed by XEVEN.` });
      created.push(item);
    } catch {}
  }
  // Add products as knowledge
  for (const p of products) {
    const t = p.title.slice(0,80);
    if (seenTitles.has(t.toLowerCase())) continue;
    try {
      const content = `${p.snippet} Price: ${p.price}. Available on ${siteUrl}.`;
      const item = knowledgeStore.createKnowledgeItem({ businessId, title: t, knowledgeType: "product", content: content.slice(0,900) });
      created.push(item);
      seenTitles.add(t.toLowerCase());
    } catch {}
  }
  // Add FAQs
  for (const f of faqs) {
    if (seenTitles.has(f.q.toLowerCase())) continue;
    try {
      const item = knowledgeStore.createKnowledgeItem({ businessId, title: f.q, knowledgeType: "faq", content: f.a.slice(0,900) });
      created.push(item);
      seenTitles.add(f.q.toLowerCase());
    } catch {}
  }

  // 2. Build guide steps
  const steps = buildGuideSteps({ siteUrl, siteType, html });

  // 2b. Learn theme & customer base — widget improves with site, except restricted
  const theme = await extractTheme(html, siteUrl);
  const customerBase = theme.customerBase || inferCustomerBase(html);

  // 3. Persist site analysis for widget (in business_configs or separate table via guide store)
  const guideStore = require("../guide/store");
  const guide = guideStore.saveGuide({ businessId, siteUrl, siteType, title, description, steps, products, faqs, knowledgeCreated: created.length, theme, customerBase });
  // also persist theme for widget adapter (so widget can fetch even without guide)
  try {
    const cfg = require("../config/service");
    cfg.updateConfig(businessId, { site: { url: siteUrl, lastAnalyzedAt: Date.now(), theme, customerBase } });
  } catch {}
  // also save to dedicated theme store for widget (fast path)
  try {
    const themeStore = require("../theme/store");
    themeStore.saveTheme(businessId, theme);
  } catch {}

  return {
    businessId,
    siteUrl,
    siteType,
    title,
    description: description.slice(0,300),
    products,
    faqs,
    steps,
    knowledgeCreated: created.length,
    guide,
    theme,
    customerBase,
  };
}

module.exports = { analyzeSite, extractProducts, extractFaqs, inferSiteType, buildGuideSteps };
