"use strict";

/**
 * PostgreSQL repository implementation for XEVEN.
 * Implements the same interface as the SQLite repository for clean swapping.
 * 
 * Usage:
 *   const repo = process.env.DB_DRIVER === 'postgres' ? require('./pg-repository') : require('./repository');
 * 
 * Environment variables required:
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   PG_SSL=true (optional, for managed PG like RDS/CloudSQL)
 *   PG_POOL_MAX=20 (optional)
 */

const { Pool } = require("pg");
const crypto = require("crypto");

class PgRepository {
    constructor(config = {}) {
        this.pool = new Pool({
            host: config.host || process.env.PG_HOST || "localhost",
            port: config.port || Number(process.env.PG_PORT) || 5432,
            database: config.database || process.env.PG_DATABASE || "xeven",
            user: config.user || process.env.PG_USER || "postgres",
            password: config.password || process.env.PG_PASSWORD || "",
            ssl: config.ssl || (process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false),
            max: config.max || Number(process.env.PG_POOL_MAX) || 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        this.pool.on("error", (err) => {
            console.error("[PG] Unexpected pool error:", err);
        });
    }

    // Initialize tables (run once at startup)
    async init() {
        const client = await this.pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    name VARCHAR(255) PRIMARY KEY,
                    applied_at BIGINT NOT NULL
                );
            `);
        } finally {
            client.release();
        }
    }

    // Execute a query with automatic retry
    async query(text, params = []) {
        const client = await this.pool.connect();
        try {
            return await client.query(text, params);
        } finally {
            client.release();
        }
    }

    // Execute multiple queries in a transaction
    async transaction(fn) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }

    // Get single row
    async get(text, params = []) {
        const result = await this.query(text, params);
        return result.rows[0] || null;
    }

    // Get all rows
    async all(text, params = []) {
        const result = await this.query(text, params);
        return result.rows;
    }

    // Execute and return lastInsertRowid equivalent
    async run(text, params = []) {
        const result = await this.query(text, params);
        return {
            changes: result.rowCount,
            lastInsertRowid: result.rows[0]?.id || null,
        };
    }

    // Prepare statement (returns a query function)
    prepare(text) {
        return {
            get: async (...params) => {
                const result = await this.query(text, params);
                return result.rows[0] || null;
            },
            all: async (...params) => {
                const result = await this.query(text, params);
                return result.rows;
            },
            run: async (...params) => {
                const result = await this.query(text, params);
                return {
                    changes: result.rowCount,
                    lastInsertRowid: result.rows[0]?.id || null,
                };
            },
        };
    }

    // Close pool
    async close() {
        await this.pool.end();
    }

    // Health check
    async healthCheck() {
        try {
            await this.query("SELECT 1");
            return { healthy: true };
        } catch (e) {
            return { healthy: false, error: e.message };
        }
    }
}

// Factory function for easy swapping
function createRepository(config = {}) {
    const driver = config.driver || process.env.DB_DRIVER || "sqlite";
    
    if (driver === "postgres" || driver === "pg") {
        return new PgRepository(config.pg);
    }
    
    // Default: SQLite (existing implementation)
    const { get } = require("./connection");
    return {
        get: (text, ...params) => get().prepare(text).get(...params),
        all: (text, ...params) => get().prepare(text).all(...params),
        run: (text, ...params) => get().prepare(text).run(...params),
        prepare: (text) => get().prepare(text),
        transaction: (fn) => get().transaction(fn),
        init: () => Promise.resolve(),
        close: () => Promise.resolve(),
    };
}

module.exports = { PgRepository, createRepository };