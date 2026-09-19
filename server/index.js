"use strict";

const env = require("./src/env");
const { logger } = require("./src/lib/logger");
const db = require("./src/db");
const configService = require("./src/core/config/service");
const { createApp } = require("./app");

function main() {
    // Initialize database + migrations.
    db.init();
    logger.info("database ready", { path: env.dbPath });

    // Validate the admin token secret source at boot (fail-fast visibility,
    // never log the value). Ephemeral secrets invalidate sessions on restart.
    try {
        const fromEnv = Boolean(env.adminTokenSecretFromEnv);
        if (!fromEnv && process.env.VERCEL) {
            logger.warn("admin token secret is ephemeral (no XEVEN_ADMIN_TOKEN_SECRET) — set it in production so sessions survive across instances");
        } else {
            logger.info("admin token secret ready", { source: fromEnv ? "env" : "persisted" });
        }
    } catch (error) {
        logger.warn("admin token secret check failed", { error: error.message });
    }

    const app = createApp();

    const server = app.listen(env.port, () => {
        logger.info("XEVEN server started", {
            port: env.port,
            environment: env.nodeEnv,
            defaultProvider: env.ai.provider,
            defaultModel: env.ai.model,
        });
    });

    // --- follow-up engine: process due emails every 15 minutes ----------------
    // (per-business policy: first_days / max_attempts / interval_days)
    const followUps = require("./src/core/followups/engine");
    let followUpRunning = false;
    async function followUpTick() {
        if (followUpRunning) return;
        followUpRunning = true;
        try {
            const result = await followUps.processDueJobs({});
            if (result.processed > 0) {
                logger.info("follow-ups processed", { count: result.processed });
            }
        } catch (error) {
            logger.warn("follow-up tick failed", { error: error.message });
        } finally {
            followUpRunning = false;
        }
    }
    setTimeout(followUpTick, 20_000).unref();
    setInterval(followUpTick, 15 * 60 * 1000).unref();

    // --- owner weekly digest: Mondays >= DIGEST_HOUR local, per business ------
    const digests = require("./src/core/digests/engine");
    let digestRunning = false;
    async function digestTick() {
        if (digestRunning) return;
        digestRunning = true;
        try {
            const result = await digests.processDueDigests({});
            if (result.sent > 0) logger.info("weekly digests sent", { count: result.sent });
        } catch (error) {
            logger.warn("digest tick failed", { error: error.message });
        } finally {
            digestRunning = false;
        }
    }
    setTimeout(digestTick, 45_000).unref();
    setInterval(digestTick, 30 * 60 * 1000).unref();

    // --- retention: purge businesses deactivated >15d, mail export to admins ---
    const retention = require("./src/core/retention");
    let retentionRunning = false;
    async function retentionTick() {
        if (retentionRunning) return;
        retentionRunning = true;
        try {
            const result = await retention.processDeactivatedBusinesses({});
            if (result.purged > 0) logger.info("retention: purged deactivated businesses", { purged: result.purged, checked: result.checked });
            else if (result.checked > 0) logger.debug("retention: checked deactivated businesses", { checked: result.checked });
        } catch (error) {
            logger.warn("retention tick failed", { error: error.message });
        } finally {
            retentionRunning = false;
        }
    }
    setTimeout(retentionTick, 60_000).unref();
    setInterval(retentionTick, 24 * 60 * 60 * 1000).unref();

    function shutdown(signal) {
        logger.info("shutting down", { signal });
        server.close(() => {
            try {
                db.close();
            } catch {
                // ignore
            }
            process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000).unref();
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    process.on("unhandledRejection", (reason) => {
        logger.error("unhandled rejection", {}, reason instanceof Error ? reason : new Error(String(reason)));
    });

    return server;
}

if (require.main === module) {
    main();
}

module.exports = { main };
