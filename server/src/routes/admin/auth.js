"use strict";

const express = require("express");
const admin = require("../../auth/admin");
const audit = require("../../core/audit/store");
const db = require("../../db");
const { badRequest, forbidden, unauthorized } = require("../../lib/errors");

const router = express.Router();

function createFromRequest(req, res) {
    const body = req.body || {};
    const result = admin.registerAdmin({
        email: body.email,
        password: body.password,
        name: body.name,
    });

    const access = admin.signAdminToken(result._raw);
    const refresh = admin.signAdminRefreshToken(result._raw);
    audit.record({ actorType: "admin", actorId: result.admin.adminUid, action: "admin.registered", ip: req.ip });
    admin.setAdminCookies(res, access, refresh);
    res.status(201).json({ admin: result.admin, accessToken: access.token, refreshToken: refresh.token, accessExpiresAt: access.expiresAt, refreshExpiresAt: refresh.expiresAt, cookieAuth: true });
}

/** Register. Open only while no accounts exist (first account = super-admin).
 *  Afterwards, an authenticated super-admin must authorize each new account. */
router.post("/register", (req, res, next) => {
    try {
        const existing = db.get().prepare(`SELECT COUNT(*) AS n FROM admin_users`).get().n;

        if (existing === 0) {
            createFromRequest(req, res);
            return;
        }

        admin.requireAdmin(req, res, (authErr) => {
            if (authErr) return next(authErr);
            try {
                if (!req.xeven || !req.xeven.isSuper) {
                    throw forbidden(
                        "Registration is closed. Only a super admin can create additional accounts.",
                        "registration_closed"
                    );
                }
                createFromRequest(req, res);
            } catch (error) {
                next(error);
            }
        });
    } catch (error) {
        next(error);
    }
});

router.post("/login", (req, res, next) => {
    try {
        const body = req.body || {};
        if (!body.email || !body.password) throw badRequest("Email and password are required.");
        const row = admin.verifyCredentials({ email: body.email, password: body.password });
        const access = admin.signAdminToken(row);
        const refresh = admin.signAdminRefreshToken(row);
        audit.record({ actorType: "admin", actorId: row.admin_uid, action: "admin.login", ip: req.ip });
        admin.setAdminCookies(res, access, refresh);
        res.json({ admin: admin.publicAdmin(row), accessToken: access.token, refreshToken: refresh.token, accessExpiresAt: access.expiresAt, refreshExpiresAt: refresh.expiresAt, cookieAuth: true });
    } catch (error) {
        next(error);
    }
});

router.post("/refresh", (req, res, next) => {
    try {
        const body = req.body || {};
        const refreshToken = body.refreshToken || body.refresh_token || admin.parseCookies(req)[admin.ADMIN_REFRESH_COOKIE];
        if (!refreshToken) throw badRequest("Refresh token is required.");

        const payload = admin.verifyAdminRefreshToken(refreshToken);
        if (!payload) throw unauthorized("Invalid or expired refresh token.", "refresh_token_invalid");

        // Revoke the used refresh token (rotation)
        admin.addRevokedToken(require("../../lib/crypto").sha256hex(refreshToken));

        const adminRow = admin.getByUid(payload.sub);
        if (!adminRow) throw unauthorized("Admin account not found.", "admin_not_found");

        const access = admin.signAdminToken(adminRow);
        const newRefresh = admin.signAdminRefreshToken(adminRow);
        admin.setAdminCookies(res, access, newRefresh);
        res.json({ accessToken: access.token, refreshToken: newRefresh.token, accessExpiresAt: access.expiresAt, refreshExpiresAt: newRefresh.expiresAt, cookieAuth: true });
    } catch (error) {
        next(error);
    }
});

router.post("/logout", admin.requireAdmin, (req, res, next) => {
    try {
        const authHeader = req.headers["authorization"];
        const match = typeof authHeader === "string" ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
        const accessToken = match?.[1];
        if (accessToken) {
            admin.addRevokedToken(require("../../lib/crypto").sha256hex(accessToken));
        }
        // Also revoke refresh token if provided
        const body = req.body || {};
        const refreshToken = body.refreshToken || body.refresh_token || admin.parseCookies(req)[admin.ADMIN_REFRESH_COOKIE];
        if (refreshToken) {
            admin.addRevokedToken(require("../../lib/crypto").sha256hex(refreshToken));
        }
        audit.record({ actorType: "admin", actorId: req.xevenAdmin.adminUid, action: "admin.logout", ip: req.ip });
        admin.clearAdminCookies(res);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

router.get("/csrf-token", admin.requireAdmin, (req, res) => {
    res.json({ csrf_token: admin.adminCsrfToken(req.xeven.adminUid) });
});

router.get("/me", admin.requireAdmin, (req, res) => {
    res.json({
        admin: req.xevenAdmin,
        businesses: admin.listAccessibleBusinesses(
            require("../../db").get().prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.xeven.adminId)
        ),
    });
});

module.exports = router;