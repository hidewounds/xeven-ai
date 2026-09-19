"use strict";

/**
 * CHRONO — Schedule store.
 * Adapted from xeven-chrono (Cal.com availability model) for XEVEN's SQLite substrate.
 * Weekly schedule is business-local 09:00-17:00 Mon-Fri by default; buffer/minNotice
 * mirror Cal's slot controls. All writes invalidate no cache explicitly — chrono
 * generates slots live with sub-second freshness (no polling).
 */

const db = require("../../db").get;
const { badRequest, notFound } = require("../../lib/errors");

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const DEFAULT_WEEKLY = {
    monday: [{ start: "09:00", end: "17:00" }],
    tuesday: [{ start: "09:00", end: "17:00" }],
    wednesday: [{ start: "09:00", end: "17:00" }],
    thursday: [{ start: "09:00", end: "17:00" }],
    friday: [{ start: "09:00", end: "17:00" }],
    saturday: [],
    sunday: [],
};

function now() { return Date.now(); }

function normalizeTime(value) {
    if (typeof value !== "string") return null;
    const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]); const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalizeWeekly(input) {
    if (!input || typeof input !== "object") return { ...DEFAULT_WEEKLY };
    const out = {};
    for (const day of DAYS) {
        const blocks = Array.isArray(input[day]) ? input[day] : [];
        out[day] = [];
        for (const b of blocks.slice(0, 4)) {
            if (!b || typeof b.start !== "string" || typeof b.end !== "string") continue;
            const s = normalizeTime(b.start); const e = normalizeTime(b.end);
            if (!s || !e || s >= e) continue;
            out[day].push({ start: s, end: e });
        }
    }
    return out;
}

function getSchedule(businessId) {
    const row = db().prepare("SELECT * FROM chrono_schedules WHERE business_id = ?").get(businessId);
    if (!row) {
        // lazily seed for new businesses created before migration ran
        const weekly = JSON.stringify(DEFAULT_WEEKLY);
        db().prepare(
            "INSERT OR IGNORE INTO chrono_schedules (business_id, timezone, slot_duration_minutes, buffer_minutes, min_notice_minutes, max_days_ahead, weekly_schedule_json, updated_at) VALUES (?, 'UTC', 60, 0, 0, 60, ?, ?)"
        ).run(businessId, weekly, now());
        // ensure new columns exist for lazily seeded rows (migration 009)
        try { db().prepare("UPDATE chrono_schedules SET max_seats_per_slot=COALESCE(max_seats_per_slot,1), hosts_json=COALESCE(hosts_json,'[]') WHERE business_id=?").run(businessId); } catch {}
        return getSchedule(businessId);
    }
    let weekly;
    try { weekly = JSON.parse(row.weekly_schedule_json); } catch { weekly = { ...DEFAULT_WEEKLY }; }
    let hosts = [];
    try { hosts = JSON.parse(row.hosts_json || "[]"); if (!Array.isArray(hosts)) hosts = []; } catch { hosts = []; }
    return {
        businessId: row.business_id,
        timezone: row.timezone || "UTC",
        slotDuration: row.slot_duration_minutes,
        bufferMinutes: row.buffer_minutes,
        minNoticeMinutes: row.min_notice_minutes,
        maxDaysAhead: row.max_days_ahead,
        maxSeatsPerSlot: row.max_seats_per_slot ?? 1,
        hosts,
        weekly: normalizeWeekly(weekly),
        updatedAt: row.updated_at,
    };
}

function setSchedule(businessId, patch = {}) {
    const current = getSchedule(businessId);
    const next = { ...current };

    if (typeof patch.timezone === "string" && patch.timezone.trim()) {
        next.timezone = patch.timezone.trim().slice(0, 80);
    }
    if (patch.slotDuration !== undefined) {
        const v = Number(patch.slotDuration);
        if (!Number.isFinite(v) || v < 10 || v > 240) throw badRequest("slotDuration must be 10-240 minutes.", "invalid_params");
        next.slotDuration = Math.round(v);
    }
    if (patch.bufferMinutes !== undefined) {
        const v = Number(patch.bufferMinutes);
        if (!Number.isFinite(v) || v < 0 || v > 120) throw badRequest("bufferMinutes must be 0-120.", "invalid_params");
        next.bufferMinutes = Math.round(v);
    }
    if (patch.minNoticeMinutes !== undefined) {
        const v = Number(patch.minNoticeMinutes);
        if (!Number.isFinite(v) || v < 0 || v > 1440) throw badRequest("minNoticeMinutes must be 0-1440.", "invalid_params");
        next.minNoticeMinutes = Math.round(v);
    }
    if (patch.maxDaysAhead !== undefined) {
        const v = Number(patch.maxDaysAhead);
        if (!Number.isFinite(v) || v < 1 || v > 365) throw badRequest("maxDaysAhead must be 1-365.", "invalid_params");
        next.maxDaysAhead = Math.round(v);
    }
    if (patch.weekly) {
        next.weekly = normalizeWeekly(patch.weekly);
    }
    if (patch.maxSeatsPerSlot !== undefined) {
        const v = Number(patch.maxSeatsPerSlot);
        if (!Number.isFinite(v) || v < 1 || v > 100) throw badRequest("maxSeatsPerSlot must be 1-100.", "invalid_params");
        next.maxSeatsPerSlot = Math.round(v);
    }
    if (patch.hosts !== undefined) {
        if (!Array.isArray(patch.hosts)) throw badRequest("hosts must be an array of {name,email}.", "invalid_params");
        const cleanHosts = [];
        for (const h of patch.hosts.slice(0, 20)) {
            if (!h || typeof h.name !== "string" || !h.name.trim()) continue;
            cleanHosts.push({ name: h.name.trim().slice(0, 80), email: String(h.email || "").trim().toLowerCase().slice(0, 120) });
        }
        next.hosts = cleanHosts;
    }

    db().prepare(
        "UPDATE chrono_schedules SET timezone=?, slot_duration_minutes=?, buffer_minutes=?, min_notice_minutes=?, max_days_ahead=?, weekly_schedule_json=?, max_seats_per_slot=?, hosts_json=?, updated_at=? WHERE business_id=?"
    ).run(next.timezone, next.slotDuration, next.bufferMinutes, next.minNoticeMinutes, next.maxDaysAhead, JSON.stringify(next.weekly), next.maxSeatsPerSlot, JSON.stringify(next.hosts || []), now(), businessId);

    return getSchedule(businessId);
}

// ── Overrides (holidays / special hours) ──

function listOverrides(businessId) {
    return db().prepare("SELECT * FROM chrono_overrides WHERE business_id=? ORDER BY date ASC").all(businessId);
}

function upsertOverride(businessId, { date, isClosed, openTime, closeTime, reason }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw badRequest("date must be YYYY-MM-DD.", "invalid_params");
    const cleanDate = String(date);
    const closed = isClosed ? 1 : 0;
    let open = ""; let close = "";
    if (!closed) {
        if (openTime) { open = normalizeTime(String(openTime)) || ""; if (!open) throw badRequest("Invalid openTime.", "invalid_params"); }
        if (closeTime) { close = normalizeTime(String(closeTime)) || ""; if (!close) throw badRequest("Invalid closeTime.", "invalid_params"); }
        if (open && close && open >= close) throw badRequest("openTime must be before closeTime.", "invalid_params");
    }
    const id = `ovr_${require("../../lib/crypto").randomHex(8)}`;
    const existing = db().prepare("SELECT override_id FROM chrono_overrides WHERE business_id=? AND date=?").get(businessId, cleanDate);
    if (existing) {
        db().prepare("UPDATE chrono_overrides SET is_closed=?, open_time=?, close_time=?, reason=? WHERE business_id=? AND date=?")
            .run(closed, open, close, String(reason || "").slice(0, 300), businessId, cleanDate);
        return db().prepare("SELECT * FROM chrono_overrides WHERE business_id=? AND date=?").get(businessId, cleanDate);
    }
    db().prepare("INSERT INTO chrono_overrides (override_id, business_id, date, is_closed, open_time, close_time, reason, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, businessId, cleanDate, closed, open, close, String(reason || "").slice(0, 300), now());
    return db().prepare("SELECT * FROM chrono_overrides WHERE override_id=?").get(id);
}

function deleteOverride(businessId, overrideId) {
    const row = db().prepare("SELECT * FROM chrono_overrides WHERE override_id=? AND business_id=?").get(overrideId, businessId);
    if (!row) throw notFound("Override not found.");
    db().prepare("DELETE FROM chrono_overrides WHERE override_id=?").run(overrideId);
    return { success: true };
}

module.exports = { DAYS, DEFAULT_WEEKLY, getSchedule, setSchedule, listOverrides, upsertOverride, deleteOverride, normalizeWeekly, normalizeTime };
