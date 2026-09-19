"use strict";
const express = require("express");
const { authenticateIntegration, requireScope } = require("../../auth/integration");
const portalAuth = require("../../auth/portal");
const guideStore = require("../../core/guide/store");

const router = express.Router();

// --- Portal routes (business owner) ---
// POST /api/portal/site/analyze — learn site, update knowledge/FAQs, build guide
router.post("/analyze", portalAuth.requirePortal, async (req, res, next) => {
  try {
    const { siteUrl, url } = req.body || {};
    const target = String(siteUrl || url || "").trim();
    if (!target || !/^https?:\/\//i.test(target)) return res.status(400).json({ error: { code: "invalid_url", message: "Provide siteUrl like https://example.com" } });
    const { analyzeSite } = require("../../core/site/analyzer");
    const result = await analyzeSite({ businessId: req.xeven.businessId, siteUrl: target });
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
});
router.get("/guide", portalAuth.requirePortal, (req, res) => {
  const guide = guideStore.getGuide(req.xeven.businessId);
  if (!guide) return res.json({ guide: null });
  res.json({ guide });
});

// --- Public integration routes (for widget to fetch guide) ---
const publicRouter = express.Router();
publicRouter.get("/guide", authenticateIntegration, (req, res) => {
  const guide = guideStore.getGuide(req.xeven.businessId);
  if (!guide) return res.json({ guide: null, message: "No guide yet" });
  res.json({ guide });
});
publicRouter.post("/analyze", authenticateIntegration, async (req, res, next) => {
  try {
    const target = String(req.body?.siteUrl || req.body?.url || "").trim();
    if (!target) return res.status(400).json({ error: { message: "siteUrl required" }});
    const { analyzeSite } = require("../../core/site/analyzer");
    const result = await analyzeSite({ businessId: req.xeven.businessId, siteUrl: target });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = { portalSiteRouter: router, publicSiteRouter: publicRouter };
