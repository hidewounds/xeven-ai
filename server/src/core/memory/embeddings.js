"use strict";

/**
 * Memory embeddings for semantic retrieval.
 * Mirrors the knowledge embeddings architecture.
 */

const db = require("../../db").get;
const { randomId } = require("../../lib/crypto");
const ai = require("../ai");
const { clampText } = require("../../lib/tokens");

const EMBEDDING_DIM = 768;

let embeddingProvider = null;

async function getEmbeddingProvider() {
    if (embeddingProvider) return embeddingProvider;

    // Deterministic pseudo-embedding (offline/testing)
    const crypto = require("crypto");
    embeddingProvider = {
        name: "deterministic",
        dim: EMBEDDING_DIM,
        async embed(texts) {
            return texts.map(t => {
                const words = String(t).toLowerCase().split(/\s+/).filter(w => w.length > 1);
                const vec = new Float32Array(EMBEDDING_DIM);
                for (const word of words) {
                    const hash = crypto.createHash("sha256").update(word).digest();
                    for (let i = 0; i < EMBEDDING_DIM; i++) {
                        vec[i] += (hash[i % 32] / 255 - 0.5) * 0.1;
                    }
                }
                let norm = 0;
                for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
                norm = Math.sqrt(norm) || 1;
                for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;
                return Array.from(vec);
            });
        },
    };
    return embeddingProvider;
}

async function initMemoryEmbeddingTables() {
    db().exec(`
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
}

function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function embedMemory(businessId, customerId, memoryUid, memoryKey, memoryValue) {
    const provider = await getEmbeddingProvider();
    const text = `${memoryKey}: ${memoryValue}`;
    const embeddings = await provider.embed([text]);
    const timestamp = Date.now();

    const embeddingId = `mem_emb_${require("../lib/crypto").randomHex(12)}`;
    const blob = Buffer.from(new Float32Array(embeddings[0]).buffer);

    db().prepare(
        `INSERT INTO memory_embeddings (embedding_id, business_id, customer_id, memory_uid, memory_key, memory_value, embedding, model, dim, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(embeddingId, businessId, customerId, memoryUid, memoryKey, memoryValue, blob, provider.name, provider.dim, timestamp);

    return { embedded: 1 };
}

async function deleteMemoryEmbeddings(businessId, customerId, memoryUid) {
    const result = db().prepare(
        `DELETE FROM memory_embeddings WHERE business_id = ? AND customer_id = ? AND memory_uid = ?`
    ).run(businessId, customerId, memoryUid);
    return result.changes;
}

async function vectorSearchMemories(businessId, customerId, query, limit = 10) {
    const provider = await getEmbeddingProvider();
    const queryEmbedding = (await provider.embed([query]))[0];

    const rows = db().prepare(
        `SELECT embedding_id, memory_uid, memory_key, memory_value, embedding
         FROM memory_embeddings
         WHERE business_id = ? AND customer_id = ?`
    ).all(businessId, customerId);

    if (!rows.length) return [];

    const scored = [];
    for (const row of rows) {
        // Buffer -> Float32Array with correct offset/length
        const buf = row.embedding;
        const embedding = buf ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) : new Float32Array(EMBEDDING_DIM);
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        scored.push({
            embedding_id: row.embedding_id,
            memory_uid: row.memory_uid,
            memory_key: row.memory_key,
            memory_value: row.memory_value,
            similarity,
        });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
}

async function hybridSearchMemories(businessId, customerId, query, { limit = 5, vectorWeight = 0.6, keywordWeight = 0.4, recencyWeight = 0.2 } = {}) {
    const { listMemories } = require("./store");

    // Get keyword-scored memories
    const keywordResults = listMemories(businessId, customerId, 200);
    const queryWords = String(query).toLowerCase().split(/\s+/).filter(w => w.length > 1);

    const keywordScored = keywordResults.map(memory => {
        let score = 0;
        for (const word of queryWords) {
            if (memory.memory_key.toLowerCase().includes(word)) score += 8;
            if (memory.memory_value.toLowerCase().includes(word)) score += 5;
            if (memory.category.toLowerCase().includes(word)) score += 3;
        }
        if (memory.origin === "explicit") score += 3;
        score += Math.min(memory.confidence || 0, 2);
        const age = Date.now() - (memory.updated_at || 0);
        if (age < 86400000) score += 3;
        else if (age < 604800000) score += 2;
        else if (age < 2592000000) score += 1;
        return { ...memory, keywordScore: score };
    }).filter(m => m.keywordScore > 0);

    keywordScored.sort((a, b) => b.keywordScore - a.keywordScore);

    // Get vector-scored memories
    const vectorResults = await vectorSearchMemories(businessId, customerId, query, 20);

    // RRF fusion
    const k = 60;
    const scores = new Map();

    keywordScored.forEach((item, rank) => {
        const key = item.memory_uid;
        const score = keywordWeight / (k + rank + 1);
        if (!scores.has(key)) scores.set(key, { item: memoryToItem(item), score: 0 });
        scores.get(key).score += score;
    });

    vectorResults.forEach((item, rank) => {
        const key = item.memory_uid;
        const score = vectorWeight / (k + rank + 1);
        if (!scores.has(key)) scores.set(key, { item: { memory_uid: item.memory_uid, memory_key: item.memory_key, memory_value: item.memory_value }, score: 0 });
        scores.get(key).score += score;
    });

    // Add recency boost
    const now = Date.now();
    for (const [key, data] of scores) {
        const mem = keywordScored.find(m => m.memory_uid === key) || vectorResults.find(m => m.memory_uid === key);
        if (mem) {
            const age = now - (mem.updated_at || mem.createdAt || 0);
            const recencyScore = age < 86400000 ? 0.3 : age < 604800000 ? 0.2 : age < 2592000000 ? 0.1 : 0;
            data.score += recencyWeight * recencyScore;
        }
    }

    const topKeys = Array.from(scores.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([key]) => key);

    const allMemories = listMemories(businessId, customerId);
    const memoryMap = new Map(allMemories.map(m => [m.memory_uid, m]));

    return topKeys
        .map(key => memoryMap.get(key))
        .filter(Boolean)
        .map(mem => ({ ...mem, hybridScore: scores.get(mem.memory_uid)?.score || 0 }));
}

function memoryToItem(memory) {
    return {
        memory_uid: memory.memory_uid,
        memory_key: memory.memory_key,
        memory_value: memory.memory_value,
    };
}

module.exports = {
    getEmbeddingProvider,
    initMemoryEmbeddingTables,
    embedMemory,
    deleteMemoryEmbeddings,
    vectorSearchMemories,
    hybridSearchMemories,
    cosineSimilarity,
};