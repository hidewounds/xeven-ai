"use strict";

const express = require("express");
const { authenticateIntegration, requireSecretKey } = require("../../auth/integration");
const analytics = require("../../core/analytics/service");

const router = express.Router();

router.use(authenticateIntegration);

router.get("/analytics/summary", requireSecretKey, (req, res) => {
    res.json(analytics.summary(req.xeven.businessId));
});

module.exports = router;
