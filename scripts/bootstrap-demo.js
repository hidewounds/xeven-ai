"use strict";
// Local dev bootstrap: ensure we have a super admin + demo business, print key.
process.env.NODE_ENV = "development";
const path = require("path");
process.chdir("D:/xeven ai");
require("dotenv").config({ path: path.join("D:/xeven ai", ".env") });
const db = require("D:/xeven ai/server/src/db");
db.init();
const crypto = require("D:/xeven ai/server/src/lib/crypto");
const admin = require("D:/xeven ai/server/src/auth/admin");
const configService = require("D:/xeven ai/server/src/core/config/service");

const EMAIL = "admin@xeven.test";
const PASSWORD = "super-secret-8";

(function main() {
    let row = db.get().prepare(`SELECT * FROM admin_users WHERE email = ?`).get(EMAIL);
    if (!row) {
        const isFirst = db.get().prepare(`SELECT COUNT(*) AS n FROM admin_users`).get().n === 0;
        db.get()
            .prepare(`INSERT INTO admin_users (admin_uid, email, name, password_hash, is_super, active, created_at, updated_at)
                      VALUES (?, ?, 'Owner', ?, ?, 1, ?, ?)`)
            .run(crypto.randomId("adm", 10), EMAIL, crypto.hashPassword(PASSWORD), isFirst ? 1 : 1, Date.now(), Date.now());
        row = db.get().prepare(`SELECT * FROM admin_users WHERE email = ?`).get(EMAIL);
        console.log("created admin", EMAIL, "isSuper=", Boolean(row.is_super));
    } else {
        // reset password so we can always get in
        db.get().prepare(`UPDATE admin_users SET password_hash = ?, is_super = 1, active = 1 WHERE id = ?`)
            .run(crypto.hashPassword(PASSWORD), row.id);
        row = db.get().prepare(`SELECT * FROM admin_users WHERE email = ?`).get(EMAIL);
        console.log("reset existing admin", EMAIL);
    }

    const { token } = admin.signAdminToken(row);

    let bizRow = db.get().prepare(`SELECT business_id FROM businesses WHERE business_name = 'XEVEN Web Demo'`).get();
    let key;
    if (bizRow) {
        key = db.get().prepare(`SELECT integration_key FROM businesses WHERE business_id = ?`).get(bizRow.business_id).integration_key;
        console.log("existing business", bizRow.business_id);
    } else {
        const created = configService.createBusiness({ businessName: "XEVEN Web Demo" });
        key = created.integrationKey;
        bizRow = { business_id: created.business.businessId };
        console.log("created business", bizRow.business_id);
    }

    configService.setBusinessPlan(bizRow.business_id, "unlimited");
    console.log("plan=unlimited");
    console.log("TOKEN=" + token);
    console.log("KEY=" + key);
})();
