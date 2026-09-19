"use strict";

/**
 * Canonical XEVEN schema.
 *
 * Every statement is idempotent so it can run against both fresh databases
 * and legacy development databases created by the old database.js without
 * destroying existing data.
 */

function ensureLegacyColumns(db) {
    // Defensive compatibility with older behavioral_events variants.
    const columns = db.prepare("PRAGMA table_info(behavioral_events)").all();
    const has = (name) => columns.some((column) => column.name === name);

    if (!has("event_id")) {
        db.exec("ALTER TABLE behavioral_events ADD COLUMN event_id TEXT");
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_behavior_event_id ON behavioral_events(event_id)");
    }
    if (!has("expires_at")) {
        db.exec("ALTER TABLE behavioral_events ADD COLUMN expires_at INTEGER");
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        db.prepare("UPDATE behavioral_events SET expires_at = created_at + ? WHERE expires_at IS NULL").run(sevenDays);
    }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    integration_key TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS business_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL UNIQUE,
    config_json TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    FOREIGN KEY (business_id)
        REFERENCES businesses (business_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS business_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    knowledge_id TEXT NOT NULL UNIQUE,
    business_id TEXT NOT NULL,
    title TEXT DEFAULT '',
    knowledge_type TEXT NOT NULL DEFAULT 'faq',
    content TEXT NOT NULL,
    metadata_json TEXT DEFAULT '{}',
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    FOREIGN KEY (business_id)
        REFERENCES businesses (business_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    name TEXT,
    email TEXT,
    phone TEXT,
    metadata_json TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    FOREIGN KEY (business_id)
        REFERENCES businesses (business_id)
        ON DELETE CASCADE,

    UNIQUE (business_id, customer_id)
);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_uid TEXT NOT NULL UNIQUE,
    business_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    category TEXT DEFAULT 'stable',
    memory_key TEXT NOT NULL,
    memory_value TEXT NOT NULL,
    confidence REAL DEFAULT 1,
    source TEXT DEFAULT 'chat',
    origin TEXT DEFAULT 'explicit',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS behavioral_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    business_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL UNIQUE,
    business_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    channel TEXT DEFAULT 'api',
    status TEXT DEFAULT 'active',
    message_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    tokens INTEGER DEFAULT 0,
    model TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_uid TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    is_super INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_business_access (
    admin_id INTEGER NOT NULL,
    business_id TEXT NOT NULL,
    granted_at INTEGER NOT NULL,

    PRIMARY KEY (admin_id, business_id),

    FOREIGN KEY (admin_id)
        REFERENCES admin_users (id)
        ON DELETE CASCADE,

    FOREIGN KEY (business_id)
        REFERENCES businesses (business_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    detail_json TEXT DEFAULT '{}',
    ip TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_customers_business ON customers (business_id);

CREATE INDEX IF NOT EXISTS idx_memories_customer ON memories (business_id, customer_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_key ON memories (business_id, customer_id, memory_key);

CREATE INDEX IF NOT EXISTS idx_behavior_customer ON behavioral_events (business_id, customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_behavior_expiry ON behavioral_events (expires_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_business ON business_knowledge (business_id, knowledge_type, active);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations (business_id, customer_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation ON conversation_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_business ON conversation_messages (business_id, customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_business ON audit_log (business_id, created_at);
`;

const MIGRATIONS = [
    {
        name: "001_canonical_schema",
        up(db) {
            db.exec(SCHEMA_SQL);
            ensureLegacyColumns(db);

            // Legacy memories tables lack memory_uid; add it and backfill.
            if (!db.prepare("PRAGMA table_info(memories)").all().some((c) => c.name === "memory_uid")) {
                db.exec("ALTER TABLE memories ADD COLUMN memory_uid TEXT");
                const rows = db.prepare("SELECT id FROM memories WHERE memory_uid IS NULL").all();
                const update = db.prepare("UPDATE memories SET memory_uid = ? WHERE id = ?");
                let counter = 1;
                for (const row of rows) {
                    update.run(`mem_legacy_${row.id}_${counter++}`, row.id);
                }
                db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON memories(memory_uid)");
            } else {
                db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON memories(memory_uid)");
            }

            // Backfill missing knowledge/event ids on upgraded databases.
            const knowledgeMissing = db
                .prepare("PRAGMA table_info(business_knowledge)")
                .all()
                .some((c) => c.name === "knowledge_id");
            if (knowledgeMissing) {
                const rows = db.prepare("SELECT id FROM business_knowledge WHERE knowledge_id IS NULL OR knowledge_id = ''").all();
                const update = db.prepare("UPDATE business_knowledge SET knowledge_id = ? WHERE id = ?");
                let counter = 1;
                for (const row of rows) {
                    update.run(`knw_legacy_${row.id}_${counter++}`, row.id);
                }
            }

            const eventsMissingId = db
                .prepare("SELECT COUNT(*) AS n FROM behavioral_events WHERE event_id IS NULL")
                .get();
            if (eventsMissingId.n > 0) {
                const rows = db.prepare("SELECT id FROM behavioral_events WHERE event_id IS NULL").all();
                const update = db.prepare("UPDATE behavioral_events SET event_id = ? WHERE id = ?");
                let counter = 1;
                for (const row of rows) {
                    update.run(`evt_legacy_${row.id}_${counter++}`, row.id);
                }
            }
        },
    },
    {
        name: "002_business_growth_suite",
        up(db) {
            db.exec(`
                -- Revenue attribution: conversations linked to business outcomes.
                CREATE TABLE IF NOT EXISTS outcome_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    outcome_uid TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    conversation_id TEXT,
                    outcome_type TEXT NOT NULL,          -- purchase | lead | booking
                    amount_cents INTEGER,                -- nullable; purchase only when known
                    source_event_id TEXT,                 -- behavioral event that produced it
                    created_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_outcomes_business ON outcome_events (business_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_outcomes_customer ON outcome_events (business_id, customer_id);

                -- Founder-toggled capabilities per business portal.
                CREATE TABLE IF NOT EXISTS feature_flags (
                    business_id TEXT PRIMARY KEY,
                    flags_json TEXT NOT NULL DEFAULT '{}',
                    updated_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );

                -- Business-owner logins for /portal (scoped to ONE business).
                CREATE TABLE IF NOT EXISTS portal_users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    portal_uid TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    active INTEGER DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );

                -- Per-business portal settings. SMTP credentials are the BUSINESS's
                -- own email identity — XEVEN never sends from itself.
                CREATE TABLE IF NOT EXISTS portal_settings (
                    business_id TEXT PRIMARY KEY,
                    contact_email TEXT DEFAULT '',
                    contact_phone TEXT DEFAULT '',
                    business_hours TEXT DEFAULT '',
                    smtp_host TEXT DEFAULT '',
                    smtp_port INTEGER DEFAULT 587,
                    smtp_user TEXT DEFAULT '',
                    smtp_pass_enc TEXT DEFAULT '',
                    smtp_from_name TEXT DEFAULT '',
                    follow_up_enabled INTEGER DEFAULT 0,
                    follow_up_first_days INTEGER DEFAULT 1,
                    follow_up_max_attempts INTEGER DEFAULT 3,
                    follow_up_interval_days INTEGER DEFAULT 2,
                    updated_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );

                -- Scheduled cart/lead follow-ups driven by the config above.
                CREATE TABLE IF NOT EXISTS follow_up_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_uid TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    email TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'cart',   -- cart | lead
                    payload_json TEXT DEFAULT '{}',      -- products, amounts, personalization
                    status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|sent|answered|dropped|opted_out
                    attempts INTEGER DEFAULT 0,
                    max_attempts INTEGER NOT NULL,
                    next_send_at INTEGER NOT NULL,
                    last_sent_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_up_jobs (status, next_send_at);
                CREATE INDEX IF NOT EXISTS idx_followups_business ON follow_up_jobs (business_id);

                -- Every outbound mail, for audit + digest math.
                CREATE TABLE IF NOT EXISTS email_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    business_id TEXT NOT NULL,
                    to_email TEXT NOT NULL,
                    subject TEXT DEFAULT '',
                    kind TEXT DEFAULT '',
                    status TEXT NOT NULL,                -- sent | failed
                    error TEXT DEFAULT '',
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_email_log_business ON email_log (business_id, created_at);
            `);
        },
    },
    {
        name: "003_owner_weekly_digest",
        up(db) {
            // Owner-facing weekly digest: recipient address + per-week dedupe key.
            const cols = db.prepare("PRAGMA table_info(portal_settings)").all().map((c) => c.name);
            if (!cols.includes("digest_email")) {
                db.exec("ALTER TABLE portal_settings ADD COLUMN digest_email TEXT DEFAULT ''");
            }
            if (!cols.includes("digest_last_sent_week")) {
                db.exec("ALTER TABLE portal_settings ADD COLUMN digest_last_sent_week TEXT DEFAULT ''");
            }
        },
    },
    {
        name: "004_legacy_memories_columns",
        up(db) {
            // Legacy databases created memories before these columns existed.
            // CREATE TABLE IF NOT EXISTS cannot add them, so chat crashed with
            // "no such column: origin". Add any that are missing.
            const cols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
            if (!cols.includes("category")) {
                db.exec("ALTER TABLE memories ADD COLUMN category TEXT DEFAULT 'stable'");
            }
            if (!cols.includes("source")) {
                db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'chat'");
            }
            if (!cols.includes("origin")) {
                db.exec("ALTER TABLE memories ADD COLUMN origin TEXT DEFAULT 'explicit'");
            }
        },
    },
    {
        name: "005_agent_capability_actions",
        up(db) {
            db.exec(`
                -- Agent-created appointments (booking.* capabilities).
                CREATE TABLE IF NOT EXISTS bookings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    booking_uid TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    conversation_id TEXT,
                    service TEXT NOT NULL,
                    scheduled_at TEXT NOT NULL,          -- ISO 8601
                    contact TEXT DEFAULT '',
                    notes TEXT DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|cancelled|completed
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_bookings_business_time ON bookings (business_id, scheduled_at);
                CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings (business_id, customer_id);

                -- Server-side confirmation intents for risky (write) capability calls.
                -- A write executes only when the customer sent a new message AFTER the
                -- intent was proposed AND the agent replays the token with confirm=true.
                CREATE TABLE IF NOT EXISTS capability_intents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    token TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    conversation_id TEXT,
                    tool TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    args_hash TEXT NOT NULL,
                    message_count INTEGER NOT NULL DEFAULT 0, -- conversation length at proposal time
                    status TEXT NOT NULL DEFAULT 'pending',   -- pending|consumed|expired
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_capability_intents_lookup ON capability_intents (business_id, customer_id, tool, args_hash, status);
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_bookings_status_time ON bookings (business_id, status, scheduled_at);
            `);
        },
    },
    {
        name: "006_business_plans",
        up(db) {
            // Commercial tier per business: launch | growth | scale | unlimited.
            // Enforced only as role-slot entitlements today; billing integration comes later.
            const cols = db.prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
            if (!cols.includes("plan")) {
                db.exec("ALTER TABLE businesses ADD COLUMN plan TEXT NOT NULL DEFAULT 'launch'");
            }
        },
    },
    {
        name: "007_chrono_engine",
        up(db) {
            // ── CHRONO: real scheduling substrate replacing synthetic slots ──
            // Weekly schedule per business (source of truth for slot generation).
            db.exec(`
                CREATE TABLE IF NOT EXISTS chrono_schedules (
                    business_id TEXT PRIMARY KEY,
                    timezone TEXT NOT NULL DEFAULT 'UTC',
                    slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
                    buffer_minutes INTEGER NOT NULL DEFAULT 0,
                    min_notice_minutes INTEGER NOT NULL DEFAULT 60,
                    max_days_ahead INTEGER NOT NULL DEFAULT 60,
                    weekly_schedule_json TEXT NOT NULL DEFAULT '{}',
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS chrono_overrides (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    override_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    is_closed INTEGER NOT NULL DEFAULT 0,
                    open_time TEXT DEFAULT '',
                    close_time TEXT DEFAULT '',
                    reason TEXT DEFAULT '',
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS chrono_slot_holds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hold_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    scheduled_at TEXT NOT NULL,
                    service TEXT DEFAULT '',
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_chrono_overrides_business_date ON chrono_overrides(business_id, date);
                CREATE INDEX IF NOT EXISTS idx_chrono_holds_business_time ON chrono_slot_holds(business_id, scheduled_at);
                CREATE INDEX IF NOT EXISTS idx_chrono_holds_expiry ON chrono_slot_holds(expires_at);
            `);
            // Seed default schedules for existing businesses so availability never empty
            const businesses = db.prepare("SELECT business_id FROM businesses").all();
            const now = Date.now();
            const defaultWeekly = JSON.stringify({
                monday: [{ start: "09:00", end: "17:00" }],
                tuesday: [{ start: "09:00", end: "17:00" }],
                wednesday: [{ start: "09:00", end: "17:00" }],
                thursday: [{ start: "09:00", end: "17:00" }],
                friday: [{ start: "09:00", end: "17:00" }],
                saturday: [],
                sunday: [],
            });
            const insert = db.prepare(
                "INSERT OR IGNORE INTO chrono_schedules (business_id, timezone, slot_duration_minutes, buffer_minutes, min_notice_minutes, max_days_ahead, weekly_schedule_json, updated_at) VALUES (?, 'UTC', 60, 0, 0, 60, ?, ?)"
            );
            for (const b of businesses) insert.run(b.business_id, defaultWeekly, now);
        },
    },
    {
        name: "008_xeven_addons_and_echo",
        up(db) {
            // ── ADD-ONS: voice_channel + multilanguage as portal-entitled add-ons ──
            db.exec(`
                CREATE TABLE IF NOT EXISTS business_addons (
                    business_id TEXT NOT NULL,
                    addon_key TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    config_json TEXT NOT NULL DEFAULT '{}',
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (business_id, addon_key),
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS echo_transcripts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transcript_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    conversation_id TEXT,
                    language TEXT DEFAULT '',
                    transcript TEXT NOT NULL,
                    duration_ms INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS echo_voice_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    call_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    phone TEXT DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    language TEXT DEFAULT '',
                    transcript_json TEXT DEFAULT '[]',
                    handoff_requested INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_addons_business ON business_addons(business_id);
                CREATE INDEX IF NOT EXISTS idx_echo_transcripts_business ON echo_transcripts(business_id, created_at);
            `);
        },
    },
    {
        name: "009_chrono_echo_internal_upgrades",
        up(db) {
            // ── CHRONO: seating capacity + round-robin hosts (no external payment needed) ──
            const schedCols = db.prepare("PRAGMA table_info(chrono_schedules)").all().map((c) => c.name);
            if (!schedCols.includes("max_seats_per_slot")) {
                db.exec("ALTER TABLE chrono_schedules ADD COLUMN max_seats_per_slot INTEGER NOT NULL DEFAULT 1");
            }
            if (!schedCols.includes("hosts_json")) {
                db.exec("ALTER TABLE chrono_schedules ADD COLUMN hosts_json TEXT NOT NULL DEFAULT '[]'");
            }
            // bookings: assigned host for round-robin
            const bCols = db.prepare("PRAGMA table_info(bookings)").all().map((c) => c.name);
            if (!bCols.includes("assigned_host")) {
                db.exec("ALTER TABLE bookings ADD COLUMN assigned_host TEXT DEFAULT ''");
            }
            if (!bCols.includes("seats")) {
                db.exec("ALTER TABLE bookings ADD COLUMN seats INTEGER NOT NULL DEFAULT 1");
            }
            // ── ECHO: store prompt + word-level timestamps (internal, no download) ──
            const eCols = db.prepare("PRAGMA table_info(echo_transcripts)").all().map((c) => c.name);
            if (!eCols.includes("initial_prompt")) {
                db.exec("ALTER TABLE echo_transcripts ADD COLUMN initial_prompt TEXT DEFAULT ''");
            }
            if (!eCols.includes("word_timestamps_json")) {
                db.exec("ALTER TABLE echo_transcripts ADD COLUMN word_timestamps_json TEXT DEFAULT '[]'");
            }
            if (!eCols.includes("model")) {
                db.exec("ALTER TABLE echo_transcripts ADD COLUMN model TEXT DEFAULT 'turbo'");
            }
        },
    },
    {
        name: "010_business_deactivation_retention",
        up(db) {
            const cols = db.prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
            if (!cols.includes("deactivated_at")) {
                db.exec("ALTER TABLE businesses ADD COLUMN deactivated_at INTEGER");
            }
            // Backfill: any currently inactive business gets deactivated_at = updated_at
            db.prepare("UPDATE businesses SET deactivated_at = updated_at WHERE active = 0 AND deactivated_at IS NULL").run();
        },
    },
    {
        name: "011_webhook_deliveries",
        up(db) {
            db.exec(`
                -- Webhook delivery tracking + dead-letter queue
                CREATE TABLE IF NOT EXISTS webhook_deliveries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    delivery_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    url TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    status_code INTEGER,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    error TEXT DEFAULT '',
                    delivered_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_business ON webhook_deliveries (business_id, delivered_at);
                CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries (status_code, delivered_at);
            `);
        },
    },
    {
        name: "012_knowledge_embeddings",
        up(db) {
            db.exec(`
                -- Knowledge embeddings for hybrid vector + keyword search
                CREATE TABLE IF NOT EXISTS knowledge_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    embedding_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    knowledge_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    chunk_text TEXT NOT NULL,
                    embedding BLOB NOT NULL, -- Float32Array as BLOB
                    model TEXT NOT NULL,
                    dim INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE,
                    FOREIGN KEY (knowledge_id)
                        REFERENCES business_knowledge (knowledge_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_biz ON knowledge_embeddings (business_id);
                CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_knowledge ON knowledge_embeddings (business_id, knowledge_id);
            `);
        },
    },
    {
        name: "013_performance_indexes",
        up(db) {
            db.exec(`
                -- Additional indexes for query performance
                CREATE INDEX IF NOT EXISTS idx_memories_origin ON memories (business_id, customer_id, origin);
                CREATE INDEX IF NOT EXISTS idx_behavior_type ON behavioral_events (business_id, event_type, created_at);
                CREATE INDEX IF NOT EXISTS idx_knowledge_type_active ON business_knowledge (business_id, knowledge_type, active);
                CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (business_id, status, updated_at);
                CREATE INDEX IF NOT EXISTS idx_outcomes_type ON outcome_events (business_id, outcome_type, created_at);
                CREATE INDEX IF NOT EXISTS idx_followups_status_time ON follow_up_jobs (business_id, status, next_send_at);
                CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log (business_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_portal_users_email ON portal_users (email);
                CREATE INDEX IF NOT EXISTS idx_embeddings_biz_knowledge ON knowledge_embeddings (business_id, knowledge_id);
            `);
        },
    },
    {
        name: "014_tts_syntheses",
        up(db) {
            db.exec(`
                -- TTS synthesis tracking
                CREATE TABLE IF NOT EXISTS tts_syntheses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    synth_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    language TEXT NOT NULL DEFAULT 'en',
                    voice TEXT DEFAULT '',
                    model TEXT NOT NULL DEFAULT 'piper',
                    audio_base64 TEXT DEFAULT '',
                    format TEXT DEFAULT 'mp3',
                    duration_ms INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,

                    FOREIGN KEY (business_id)
                        REFERENCES businesses (business_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_tts_syntheses_biz ON tts_syntheses (business_id, created_at);
            `);
        },
    },
    {
        name: "015_idempotency_keys",
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    business_id TEXT NOT NULL,
                    key_hash TEXT NOT NULL,
                    tool TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses (business_id) ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_biz_key ON idempotency_keys (business_id, key_hash);
                CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);
            `);
        },
    },
    {
        name: "016_ai_circuit_breakers",
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS ai_circuit_breakers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider_name TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL DEFAULT 'closed',
                    failures INTEGER NOT NULL DEFAULT 0,
                    successes INTEGER NOT NULL DEFAULT 0,
                    last_failure INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
            `);
        },
    },
    {
        name: "017_memory_embeddings",
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    embedding_id TEXT NOT NULL UNIQUE,
                    business_id TEXT NOT NULL,
                    customer_id TEXT NOT NULL,
                    memory_uid TEXT NOT NULL,
                    memory_key TEXT NOT NULL,
                    memory_value TEXT NOT NULL,
                    embedding BLOB NOT NULL,
                    model TEXT NOT NULL,
                    dim INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_memory_embeddings_biz ON memory_embeddings (business_id);
                CREATE INDEX IF NOT EXISTS idx_memory_embeddings_customer ON memory_embeddings (business_id, customer_id);
                CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory ON memory_embeddings (business_id, customer_id, memory_uid);
            `);
        },
    },
    {
        name: "018_attribution_persistence",
        up(db) {
            db.exec(`
                -- Add attribution column to outcome_events
                ALTER TABLE outcome_events ADD COLUMN attribution_json TEXT DEFAULT '{}';
                CREATE INDEX IF NOT EXISTS idx_outcomes_attribution ON outcome_events (business_id, outcome_type);
            `);
        },
    },
    {
        name: "019_digest_schedule",
        up(db) {
            db.exec(`
                -- Weekly digest scheduling
                CREATE TABLE IF NOT EXISTS digest_schedule (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    business_id TEXT NOT NULL,
                    week_start INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
                    recipient_email TEXT NOT NULL,
                    digest_text TEXT,
                    sent_at INTEGER,
                    error TEXT,
                    created_at INTEGER NOT NULL,
                    UNIQUE(business_id, week_start),
                    FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_digest_schedule_biz_week ON digest_schedule (business_id, week_start);
                CREATE INDEX IF NOT EXISTS idx_digest_schedule_status ON digest_schedule (status, week_start);
            `);
        },
    },
    {
        name: "020_integration_key_hash",
        up(db) {
            const cols = db.prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
            if (!cols.includes("integration_key_hash")) {
                db.exec("ALTER TABLE businesses ADD COLUMN integration_key_hash TEXT");
                // backfill hash for existing keys (sha256 for lookup, keep plain for rotation compat)
                const rows = db.prepare("SELECT business_id, integration_key FROM businesses WHERE integration_key IS NOT NULL").all();
                const crypto = require("crypto");
                const upd = db.prepare("UPDATE businesses SET integration_key_hash = ? WHERE business_id = ?");
                for (const r of rows) {
                    const h = crypto.createHash("sha256").update(String(r.integration_key)).digest("hex");
                    upd.run(h, r.business_id);
                }
                db.exec("CREATE INDEX IF NOT EXISTS idx_businesses_key_hash ON businesses(integration_key_hash)");
            }
        },
    },
    {
        name: "021_widget_public_key",
        up(db) {
            const cols = db.prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
            if (!cols.includes("widget_public_key")) {
                db.exec("ALTER TABLE businesses ADD COLUMN widget_public_key TEXT");
                // Backfill: deterministic one-way derivation from the secret key.
                // Knowing the publishable key reveals nothing about the secret.
                const rows = db.prepare("SELECT business_id, integration_key FROM businesses WHERE integration_key IS NOT NULL").all();
                const crypto = require("crypto");
                const upd = db.prepare("UPDATE businesses SET widget_public_key = ? WHERE business_id = ?");
                for (const r of rows) {
                    const pub = `xeven_pk_pub_${crypto.createHash("sha256").update(String(r.integration_key)).digest("hex").slice(0, 32)}`;
                    upd.run(pub, r.business_id);
                }
                db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_widget_public_key ON businesses(widget_public_key)");
            }
        },
    },
];

function migrate(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
    `);

    const applied = new Set(
        database.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name)
    );

    for (const migration of MIGRATIONS) {
        if (applied.has(migration.name)) continue;
        const run = database.transaction(() => {
            migration.up(database);
            database
                .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
                .run(migration.name, Date.now());
        });
        run();
    }
}

module.exports = { migrate, MIGRATIONS };