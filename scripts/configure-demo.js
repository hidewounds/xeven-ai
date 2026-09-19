"use strict";
// Configure XEVEN Web Demo business: all 8 core skills stacked + demo knowledge.
process.env.NODE_ENV = "development";
const path = require("path");
require("dotenv").config({ path: path.join("D:/xeven ai", ".env") });
const db = require("D:/xeven ai/server/src/db");
db.init();
const configService = require("D:/xeven ai/server/src/core/config/service");
const knowledge = require("D:/xeven ai/server/src/core/knowledge/store");

const BUSINESS = "xeven_web_demo";

const config = configService.updateConfig(BUSINESS, {
    assistant: {
        name: "Xeven",
        role: "customer_support",
        roles: [
            "customer_support",
            "sales",
            "shopping_assistant",
            "product_advisor",
            "booking_assistant",
            "lead_qualification",
            "general_assistant",
            "custom",
        ],
        personality: "Friendly, concise and honest. You are Xeven, the whole customer-facing team of the demo store in one assistant.",
        welcomeMessage: "Hi! I'm Xeven — support, sales, product advice and bookings in one chat. How can I help?",
        businessDescription:
            "XEVEN Web Demo is a small online store selling tech gadgets and accessories. It also offers in-store consultation appointments that can be booked online.",
    },
    features: { capabilities: { "booking.availability": true, "booking.create": true, "booking.list": true } },
});

console.log("stacked roles:", config.assistant.roles.join(", "));

const items = [
    { title: "Return Policy", type: "policy", content: "Customers may return any item within 30 days of delivery for a full refund. Items must be unused and in original packaging. Sale items are final after 14 days." },
    { title: "Shipping Policy", type: "policy", content: "Free shipping on orders over $75. Orders under $75 ship for a flat $6.99 within the US. Delivery takes 3-5 business days. We ship Monday to Friday." },
    { title: "Warranty", type: "policy", content: "All electronics carry a 12-month manufacturer warranty. Accessories have a 90-day warranty. Warranty claims require proof of purchase." },
    { title: "Product: AeroBuds Pro", type: "product", content: "AeroBuds Pro wireless earbuds — $129. Active noise cancellation, 8h battery (32h with case), IPX4 water resistant. Available colors: black, white." },
    { title: "Product: Sport Pulse Digital Watch", type: "product", content: "Sport Pulse Digital watch — $89. Heart-rate monitor, GPS, 5-day battery, waterproof to 50m. One size strap, black or navy." },
    { title: "Product: Chrono Steel Watch", type: "product", content: "Chrono Steel analog watch — $299 (was $349). Sapphire glass, stainless steel band, 2-year warranty. Limited stock." },
    { title: "Store Hours & Consultations", type: "faq", content: "Our showroom is open Mon-Fri 9:00-17:00. Free 30-minute product consultations can be booked online; consultations happen at our Berlin showroom." },
];

for (const item of items) {
    const exists = knowledge.listKnowledge(BUSINESS).some((k) => k.title === item.title);
    if (!exists) knowledge.createKnowledgeItem({ businessId: BUSINESS, title: item.title, knowledgeType: item.type, content: item.content });
}
console.log("knowledge seeded:", knowledge.listKnowledge(BUSINESS).length, "entries");
