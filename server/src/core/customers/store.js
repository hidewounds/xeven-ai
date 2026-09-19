"use strict";

/**
 * Canonical customer store. Customers belong to exactly one business.
 */

const db = require("../../db").get;
const { normalizeBusinessId } = require("../config/service");
const { badRequest } = require("../../lib/errors");

const CUSTOMER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,150}$/;

function validateCustomerId(value) {
    const id = String(value || "").trim().slice(0, 150);
    if (!id || !CUSTOMER_ID_PATTERN.test(id)) return null;
    return id;
}

function cleanString(value, maximum) {
    if (value === undefined || value === null) return null;
    return String(value).trim().slice(0, maximum) || null;
}

function cleanMetadata(metadata) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    try {
        const serialized = JSON.stringify(metadata);
        if (serialized.length > 10_000) return {};
        return JSON.parse(serialized);
    } catch {
        return {};
    }
}

function getCustomerRow(businessId, customerId) {
    return (
        db()
            .prepare(
                `SELECT id, business_id, customer_id, name, email, phone, metadata_json, created_at, updated_at
                 FROM customers
                 WHERE business_id = ? AND customer_id = ?
                 LIMIT 1`
            )
            .get(normalizeBusinessId(businessId), String(customerId || "")) || null
    );
}

function parseCustomer(row) {
    if (!row) return null;
    let metadata = {};
    try {
        metadata = JSON.parse(row.metadata_json || "{}");
    } catch {
        metadata = {};
    }
    return {
        id: row.id,
        customerId: row.customer_id,
        businessId: row.business_id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function getCustomer(businessId, customerId) {
    return parseCustomer(getCustomerRow(businessId, customerId));
}

/**
 * Insert or merge-update a customer. Null fields never overwrite existing data
 * unless `metadata` is explicitly provided as an object (full replace).
 */
function upsertCustomer({ businessId, customerId, name, email, phone, metadata }) {
    const business = normalizeBusinessId(businessId);
    const id = validateCustomerId(customerId);
    if (!id) throw badRequest("A valid customer ID is required.", "invalid_customer_id");

    const existing = getCustomerRow(business, id);
    const timestamp = Date.now();

    const cleanName = cleanString(name, 200);
    const cleanEmail = cleanString(email, 320);
    const cleanPhone = cleanString(phone, 50);
    const hasMetadata = metadata !== undefined && metadata !== null;

    if (existing) {
        const metadataJson = hasMetadata ? JSON.stringify(cleanMetadata(metadata)) : null;
        db()
            .prepare(
                `UPDATE customers
                 SET name = COALESCE(?, name),
                     email = COALESCE(?, email),
                     phone = COALESCE(?, phone),
                     metadata_json = CASE WHEN ? IS NULL THEN metadata_json ELSE ? END,
                     updated_at = ?
                 WHERE business_id = ? AND customer_id = ?`
            )
            .run(cleanName, cleanEmail, cleanPhone, metadataJson, metadataJson, timestamp, business, id);
    } else {
        db()
            .prepare(
                `INSERT INTO customers (business_id, customer_id, name, email, phone, metadata_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(business, id, cleanName, cleanEmail, cleanPhone, JSON.stringify(hasMetadata ? cleanMetadata(metadata) : {}), timestamp, timestamp);
    }

    return getCustomer(business, id);
}

function listCustomers(businessId, { limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = db()
        .prepare(
            `SELECT id, business_id, customer_id, name, email, phone, metadata_json, created_at, updated_at
             FROM customers
             WHERE business_id = ?
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`
        )
        .all(normalizeBusinessId(businessId), safeLimit, safeOffset);

    const total = db()
        .prepare(`SELECT COUNT(*) AS n FROM customers WHERE business_id = ?`)
        .get(normalizeBusinessId(businessId)).n;

    return { customers: rows.map(parseCustomer), total, limit: safeLimit, offset: safeOffset };
}

/** Delete a customer and all XEVEN-owned data for that customer. */
function deleteCustomer(businessId, customerId) {
    const business = normalizeBusinessId(businessId);
    const id = String(customerId || "");

    return db().transaction(() => {
        db().prepare(`DELETE FROM behavioral_events WHERE business_id = ? AND customer_id = ?`).run(business, id);
        db().prepare(`DELETE FROM memories WHERE business_id = ? AND customer_id = ?`).run(business, id);
        db().prepare(`DELETE FROM conversation_messages WHERE business_id = ? AND customer_id = ?`).run(business, id);
        db().prepare(`DELETE FROM conversations WHERE business_id = ? AND customer_id = ?`).run(business, id);
        const result = db()
            .prepare(`DELETE FROM customers WHERE business_id = ? AND customer_id = ?`)
            .run(business, id);
        return result.changes > 0;
    })();
}

module.exports = {
    validateCustomerId,
    getCustomer,
    upsertCustomer,
    listCustomers,
    deleteCustomer,
};
