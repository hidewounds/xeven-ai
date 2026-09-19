"use strict";

const express = require("express");
const { authenticateIntegration } = require("../../auth/integration");
const { getSchedule, setSchedule, listOverrides, upsertOverride, deleteOverride } = require("../../core/chrono/schedule");
const { generateAvailability } = require("../../core/chrono/slots");
const { holdSlot } = require("../../core/chrono/bookings");

const router = express.Router();

// All chrono platform routes are integration-key scoped (business tenant)
router.use(authenticateIntegration);

// GET /api/v1/chrono/schedule — read live schedule (sub-second fresh)
router.get("/schedule", (req, res, next) => {
    try {
        const sched = getSchedule(req.xeven.businessId);
        const overrides = listOverrides(req.xeven.businessId);
        res.json({ schedule: sched, overrides });
    } catch (e) { next(e); }
});

// PUT /api/v1/chrono/schedule — update weekly hours, durations, buffers (instant propagation)
router.put("/schedule", (req, res, next) => {
    try {
        const patched = setSchedule(req.xeven.businessId, req.body || {});
        // no cache to invalidate — chrono generates live, so update is visible to next availability call instantly
        res.json({ schedule: patched });
    } catch (e) { next(e); }
});

// GET /api/v1/chrono/availability?startDate=YYYY-MM-DD&days=14
router.get("/availability", (req, res, next) => {
    try {
        const startDate = String(req.query.startDate || req.query.date || "").trim() || undefined;
        const days = Number(req.query.days || req.query.horizonDays || 14);
        const rank = String(req.query.rank || "1") !== "0";
        const avail = generateAvailability(req.xeven.businessId, { startDate, days, rank });
        res.json({ availability: avail });
    } catch (e) { next(e); }
});

// GET /api/v1/chrono/overrides
router.get("/overrides", (req, res, next) => {
    try { res.json({ overrides: listOverrides(req.xeven.businessId) }); } catch (e) { next(e); }
});

// POST /api/v1/chrono/overrides {date, isClosed, openTime, closeTime, reason}
router.post("/overrides", (req, res, next) => {
    try { const ov = upsertOverride(req.xeven.businessId, req.body || {}); res.status(201).json({ override: ov }); } catch (e) { next(e); }
});

// DELETE /api/v1/chrono/overrides/:id
router.delete("/overrides/:id", (req, res, next) => {
    try { const r = deleteOverride(req.xeven.businessId, String(req.params.id)); res.json(r); } catch (e) { next(e); }
});

// POST /api/v1/chrono/holds {scheduledAt, service} — 5-min reservation during confirmation
router.post("/holds", (req, res, next) => {
    try {
        const body = req.body || {};
        const customerId = String(body.customerId || "anonymous").slice(0, 80);
        const hold = holdSlot({ businessId: req.xeven.businessId, customerId, scheduledAt: body.scheduledAt || body.datetime, service: body.service });
        res.status(201).json({ hold });
    } catch (e) { next(e); }
});

module.exports = router;
