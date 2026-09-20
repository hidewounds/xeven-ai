"use strict";

const env = require("../env");
const connection = require("./connection");
const { migrate } = require("./schema");
const { PgRepository, createRepository } = require("./pg-repository");

let _repository = null;

/**
 * Initialize the database connection and apply migrations.
 * Ready-on-setup: if DB_DRIVER=postgres but `pg` not installed or PG unreachable,
 * falls back to SQLite and logs a warning — no crash, sits idle until configured.
 * Safe to call multiple times; returns the singleton connection.
 */
function init(options = {}) {
    const driver = String(options.driver || process.env.DB_DRIVER || env.dbDriver || "sqlite").toLowerCase();

    if (driver === "postgres" || driver === "pg") {
        try {
            // Check `pg` is installed before attempting
            require.resolve("pg");
            _repository = new PgRepository({
                host: options.pg?.host || env.pgHost,
                port: options.pg?.port || env.pgPort,
                database: options.pg?.database || env.pgDatabase,
                user: options.pg?.user || env.pgUser,
                password: options.pg?.password || env.pgPassword,
                ssl: options.pg?.ssl ?? env.pgSsl,
            });
            // Return promise — caller may await, but we also store fallback timer
            const p = _repository.init().then(() => _repository).catch((err) => {
                console.warn("[db] PG init failed, falling back to SQLite:", err.message);
                const targetPath = options.dbPath || env.dbPath;
                const db = connection.connect(targetPath);
                migrate(db);
                _repository = createRepository({ driver: "sqlite" });
                return _repository;
            });
            // For sync callers (createApp), also set a temporary SQLite fallback immediately
            // so `get()` doesn't throw before PG connects. PG promise will replace it.
            if (!_repository) {
                const targetPath = options.dbPath || env.dbPath;
                try {
                    const db = connection.connect(targetPath);
                    migrate(db);
                    _repository = createRepository({ driver: "sqlite" });
                } catch {}
            }
            return p;
        } catch (e) {
            console.warn("[db] PG driver requested but `pg` not installed or PG env missing, using SQLite:", e.message);
        }
    }

    const targetPath = options.dbPath || env.dbPath;
    const db = connection.connect(targetPath);
    migrate(db);
    _repository = createRepository({ driver: "sqlite" });
    // Self-healing seed for ephemeral stores (Vercel /tmp). No-op unless
    // XEVEN_SEED_ON_BOOT=1 and the database is empty. Never throws.
    try {
        require("./seed").maybeSeed();
    } catch (err) {
        console.warn("[db] seed skipped:", err.message);
    }
    return _repository;
}

function getRepository() {
    if (!_repository) {
        init();
    }
    return _repository;
}

function setRepository(repo) {
    _repository = repo;
}

module.exports = {
    init,
    get: () => getRepository(),
    setRepository,
    tx: connection.tx,
    close: connection.close,
    columnExists: connection.columnExists,
    createRepository,
    PgRepository,
};
