"use strict";
// Embed XEVEN widget + tracker before </body> on all public pages.
const fs = require("fs");
const path = require("path");

const KEY = process.env.XEVEN_PUBLISHABLE_KEY || process.env.XEVEN_WALKTHROUGH_KEY || "xeven_pk_40d32c478e27559616acfd7827347d437b1c207d3d9f1e1c0375759d81bbb6da";
const API = process.env.XEVEN_API_BASE || process.env.XEVEN_BASE_URL || "http://localhost:3000";

const SNIPPET = `
<!-- XEVEN assistant (all skills: support · sales · shopping · advisor · booking · leads) -->
<script src="${API}/widget/xeven-tracker.js" data-public-key="${KEY}" data-api="${API}" defer></script>
<script src="${API}/widget/xeven-widget.js" data-public-key="${KEY}" data-api="${API}" defer></script>`;

const dir = process.env.XEVEN_WEB_DIR || path.join(__dirname, "..", "..", "xeven web");
for (const file of ["index.html", "pricing.html", "roles.html", "features.html"]) {
    const full = path.join(dir, file);
    let html = fs.readFileSync(full, "utf8");
    if (html.includes("xeven-widget.js")) { console.log(file, "-> already embedded"); continue; }
    if (!html.includes("</body>")) { console.log(file, "-> no </body>, skipped"); continue; }
    html = html.replace(/<\/body>/i, SNIPPET + "\n</body>");
    fs.writeFileSync(full, html, "utf8");
    console.log(file, "-> embedded");
}
