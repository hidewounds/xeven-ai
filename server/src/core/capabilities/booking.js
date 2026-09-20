"use strict";

/**
 * Booking capability handlers — now powered by CHRONO.
 * Tenant-scoped; businessId from auth only.
 *
 * Previously synthetic (Mon-Fri 09-17 hourly). Now chrono schedule-driven:
 * weekly hours + overrides + buffer/minNotice/maxDaysAhead + holds, with real-time
 * freshness (writes invalidate instantly, no poll loop).
 */

const db = require("../../db").get;
const { badRequest } = require("../../lib/errors");

// chrono substrate (falls back to legacy template if chrono tables missing pre-migration)
let chronoSlots = null; let chronoBookings = null;
try { chronoSlots = require("../chrono/slots"); } catch {}
try { chronoBookings = require("../chrono/bookings"); } catch {}

function isValidIsoDatetime(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime());
}

// ── availability: chrono-backed with ranked slots ──
function availability({ businessId }, params = {}) {
    // chrono path (live schedule)
    if (chronoSlots && typeof chronoSlots.generateAvailability === "function") {
        try {
            const opts = {};
            if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) opts.startDate = params.date;
            if (params.days) opts.days = Math.min(90, Math.max(1, Number(params.days) || 14));
            else if (params.horizonDays) opts.days = Math.min(90, Math.max(1, Number(params.horizonDays) || 14));
            else opts.days = 5; // keep legacy 5-day contract for tool; widget requests 14 explicitly
            // rank to surface best times first (no rush)
            const result = chronoSlots.availabilityWithRanking
                ? chronoSlots.availabilityWithRanking(businessId, opts)
                : chronoSlots.generateAvailability(businessId, { ...opts, rank: true });
            // keep backward-compat shape: days[].openSlots; also expose ranked helpers
            // plus chrono metadata
            return {
                note: result.note,
                timezone: result.timezone,
                slotDuration: result.slotDuration,
                horizonDays: result.horizonDays,
                days: result.days.map((d) => ({ date: d.date, openSlots: d.openSlots, slots: d.slots })),
            };
        } catch (e) {
            // fall through to legacy if chrono seed missing
            if (e.code !== "invalid_params") { /* continue */ }
        }
    }

    // legacy fallback (never empty)
    const start = params.date ? new Date(`${params.date}T00:00:00Z`) : new Date();
    if (Number.isNaN(start.getTime())) throw badRequest("Invalid date; expected YYYY-MM-DD.", "invalid_params");
    const toIsoDate = (d) => d.toISOString().slice(0, 10);
    const listBookedSlots = (dayIso) => db().prepare(
        "SELECT scheduled_at FROM bookings WHERE business_id = ? AND status = 'confirmed' AND substr(scheduled_at, 1, 10) = ?"
    ).all(businessId, dayIso).map((r) => r.scheduled_at);
    const bookedCache = new Map();
    const days = [];
    const cursor = new Date(start);
    // NOTE: first iteration is today-inclusive only when no explicit date was
    // given; every iteration must advance the cursor (guarded) or weekends
    // loop forever (Sat/Sun start never pushes a day).
    let guard = 0;
    while (days.length < 5 && guard++ < 400) {
        cursor.setUTCDate(cursor.getUTCDate() + (days.length === 0 && !params.date && guard === 1 ? 0 : 1));
        const dow = cursor.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const dayIso = toIsoDate(cursor);
        if (!bookedCache.has(dayIso)) bookedCache.set(dayIso, new Set(listBookedSlots(dayIso).map((iso) => iso.slice(11, 16))));
        const taken = bookedCache.get(dayIso);
        const slots = [];
        for (let hour = 9; hour < 17; hour++) {
            const slot = `${String(hour).padStart(2, "0")}:00`;
            if (!taken.has(slot)) slots.push(slot);
            if (slots.length >= 8) break;
        }
        days.push({ date: dayIso, openSlots: slots });
    }
    return { note: "Indicative availability. Confirm a specific date and time with the customer before booking.", days };
}

function createBooking(ctx, params) {
    if (chronoBookings && typeof chronoBookings.createBooking === "function") {
        return chronoBookings.createBooking(ctx, params);
    }
    // legacy fallback
    const service = String(params.service || "").trim().slice(0, 200);
    const contact = String(params.contact || "").trim().slice(0, 200);
    const notes = String(params.notes || "").trim().slice(0, 1000);
    if (!service) throw badRequest("booking.create requires a service name.", "invalid_params");
    if (!isValidIsoDatetime(params.datetime)) throw badRequest("booking.create requires datetime as ISO 8601 (e.g. 2026-09-01T10:00:00Z).", "invalid_params");
    const scheduledAt = new Date(params.datetime).toISOString();
    const conflict = db().prepare("SELECT booking_uid FROM bookings WHERE business_id = ? AND status = 'confirmed' AND scheduled_at = ? LIMIT 1").get(ctx.businessId, scheduledAt);
    if (conflict) throw badRequest("That time slot was just taken — offer another slot.", "slot_conflict");
    const uid = `bkg_${require("../../lib/crypto").randomHex(12)}`;
    const now = Date.now();
    db().prepare("INSERT INTO bookings (booking_uid, business_id, customer_id, conversation_id, service, scheduled_at, contact, notes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)")
        .run(uid, ctx.businessId, ctx.customerId, ctx.conversationId || null, service, scheduledAt, contact, notes, now, now);
    return { bookingRef: uid, service, scheduledAt, status: "confirmed", message: `Booking confirmed. Reference ${uid}.` };
}

function listCustomerBookings({ businessId, customerId }) {
    if (chronoBookings && typeof chronoBookings.listCustomerBookings === "function") {
        return chronoBookings.listCustomerBookings({ businessId, customerId });
    }
    const rows = db().prepare("SELECT booking_uid, service, scheduled_at, status, created_at FROM bookings WHERE business_id = ? AND customer_id = ? ORDER BY scheduled_at ASC LIMIT 20").all(businessId, customerId);
    return { bookings: rows };
}

module.exports = { availability, createBooking, listCustomerBookings, isValidIsoDatetime };
