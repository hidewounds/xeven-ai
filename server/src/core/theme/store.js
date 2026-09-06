"use strict";
const getDb = () => {
    try { return require("../../db/connection").get(); } catch { return require("../../db").get(); }
};

function ensureTable() {
    const db = getDb();
    if (!db) return;
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS business_themes (
                business_id TEXT PRIMARY KEY,
                theme_json TEXT NOT NULL DEFAULT '{}',
                customer_base TEXT DEFAULT '',
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
            );
        `);
    } catch {}
}

function saveTheme(businessId, theme) {
    ensureTable();
    const db = getDb();
    const now = Date.now();
    const customerBase = (theme && theme.customerBase) ? String(theme.customerBase).slice(0,200) : "";
    const themeJson = JSON.stringify(theme || {});
    try {
        db.prepare(`
            INSERT INTO business_themes (business_id, theme_json, customer_base, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(business_id) DO UPDATE SET theme_json=excluded.theme_json, customer_base=excluded.customer_base, updated_at=excluded.updated_at
        `).run(businessId, themeJson, customerBase, now);
    } catch {}
    return getTheme(businessId);
}

function getTheme(businessId) {
    ensureTable();
    const db = getDb();
    try {
        const row = db.prepare("SELECT * FROM business_themes WHERE business_id=?").get(businessId);
        if (!row) return null;
        let theme = {};
        try { theme = JSON.parse(row.theme_json || "{}"); } catch { theme = {}; }
        return { theme, customerBase: row.customer_base || theme.customerBase || "", updatedAt: row.updated_at };
    } catch { return null; }
}

module.exports = { saveTheme, getTheme };
