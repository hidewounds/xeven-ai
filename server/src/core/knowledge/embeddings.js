"use strict";

/**
 * Embedding generation and vector search for knowledge retrieval.
 * Deterministic offline embeddings (OpenAI embeddings can be wired here later).
 */

const db = require("../../db").get;
const { randomId } = require("../../lib/crypto");
const ai = require("../ai");
const { clampText } = require("../../lib/tokens");

const EMBEDDING_DIM = 768;
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;

let embeddingProvider = null;

async function getEmbeddingProvider() {
    if (embeddingProvider) return embeddingProvider;

    // Deterministic pseudo-embedding (offline/testing)
    embeddingProvider = {
        name: "random",
        embed(texts) {
            return texts.map(t => deterministicEmbedding(t));
        },
        dim: EMBEDDING_DIM,
    };
    return embeddingProvider;
}

/** Deterministic pseudo-embedding for offline/testing (not for production). */
function deterministicEmbedding(text) {
    const crypto = require("crypto");
    const words = String(text).toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const vec = new Float32Array(EMBEDDING_DIM);
    
    for (const word of words) {
        const hash = crypto.createHash("sha256").update(word).digest();
        for (let i = 0; i < EMBEDDING_DIM; i++) {
            vec[i] += (hash[i % 32] / 255 - 0.5) * 0.1;
        }
    }
    
    // Normalize
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;
    
    return Array.from(vec);
}

/** Split text into overlapping chunks. */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const words = String(text).split(/\s+/);
    const chunks = [];
    let i = 0;
    while (i < words.length) {
        const chunk = words.slice(i, i + size).join(" ");
        if (chunk.trim()) chunks.push(chunk.trim());
        i += size - overlap;
    }
    return chunks;
}

/** Initialize embedding tables. */
async function initEmbeddingTables() {
    db().exec(`
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
            FOREIGN KEY (business_id) REFERENCES businesses(business_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_biz ON knowledge_embeddings (business_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_knowledge ON knowledge_embeddings (business_id, knowledge_id);
    `);
}

/** Generate and store embeddings for a knowledge item. */
async function embedKnowledgeItem(businessId, knowledgeId, content, title = "") {
    const provider = await getEmbeddingProvider();
    const fullText = `${title}\n\n${content}`;
    const chunks = chunkText(fullText);
    
    if (!chunks.length) return { embedded: 0 };
    
    const embeddings = await provider.embed(chunks);
    const timestamp = Date.now();
    let stored = 0;
    
    for (let i = 0; i < chunks.length; i++) {
        const embeddingId = `emb_${require("../lib/crypto").randomHex(12)}`;
        const blob = Buffer.from(new Float32Array(embeddings[i]).buffer);
        
        db().prepare(
            `INSERT INTO knowledge_embeddings (embedding_id, business_id, knowledge_id, chunk_index, chunk_text, embedding, model, dim, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(embeddingId, businessId, knowledgeId, i, chunks[i], blob, provider.name, provider.dim, timestamp);
        stored++;
    }
    
    return { embedded: stored, chunks: chunks.length };
}

/** Remove embeddings for a knowledge item. */
async function deleteKnowledgeEmbeddings(businessId, knowledgeId) {
    const result = db().prepare(
        `DELETE FROM knowledge_embeddings WHERE business_id = ? AND knowledge_id = ?`
    ).run(businessId, knowledgeId);
    return result.changes;
}

/** Cosine similarity between two vectors. */
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

/** Vector search over knowledge embeddings. */
async function vectorSearchKnowledge(businessId, query, limit = 10) {
    const provider = await getEmbeddingProvider();
    const queryEmbedding = (await provider.embed([query]))[0];
    
    const rows = db().prepare(
        `SELECT embedding_id, knowledge_id, chunk_index, chunk_text, embedding
         FROM knowledge_embeddings
         WHERE business_id = ?`
    ).all(businessId);
    
    if (!rows.length) return [];
    
    const scored = [];
    for (const row of rows) {
        const buf = row.embedding;
        const embedding = buf ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) : new Float32Array(EMBEDDING_DIM);
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        scored.push({
            embedding_id: row.embedding_id,
            knowledge_id: row.knowledge_id,
            chunk_index: row.chunk_index,
            chunk_text: row.chunk_text,
            similarity,
        });
    }
    
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
}

/** Hybrid search: combine keyword + vector with RRF. */
async function hybridSearchKnowledge(businessId, query, { limit = 4, keywordWeight = 0.4, vectorWeight = 0.6 } = {}) {
    const { searchKnowledge } = require("./store");
    const keywordResults = searchKnowledge(businessId, query, 20);
    const vectorResults = await vectorSearchKnowledge(businessId, query, 20);
    
    // Reciprocal Rank Fusion
    const k = 60; // RRF constant
    const scores = new Map();
    
    // Keyword results
    keywordResults.forEach((item, rank) => {
        const key = item.knowledge_id;
        const score = keywordWeight / (k + rank + 1);
        if (!scores.has(key)) scores.set(key, { item, score: 0 });
        scores.get(key).score += score;
    });
    
    // Vector results
    vectorResults.forEach((item, rank) => {
        const key = item.knowledge_id;
        const score = vectorWeight / (k + rank + 1);
        if (!scores.has(key)) scores.set(key, { item: { knowledge_id: item.knowledge_id, chunk_text: item.chunk_text }, score: 0 });
        scores.get(key).score += score;
    });
    
    // Get full knowledge items for top results
    const topKeys = Array.from(scores.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([key]) => key);
    
    const { listKnowledge } = require("./store");
    const allResult = listKnowledge(businessId, { includeInactive: false });
    const allItems = Array.isArray(allResult) ? allResult : (allResult.items || []);
    const itemMap = new Map(allItems.map(item => [item.knowledge_id, item]));
    
    return topKeys
        .map(key => itemMap.get(key))
        .filter(Boolean)
        .map(item => ({ ...item, hybridScore: scores.get(item.knowledge_id)?.score || 0 }));
}

/** Rebuild all embeddings for a business (background job). */
async function rebuildBusinessEmbeddings(businessId) {
    await deleteKnowledgeEmbeddings(businessId);
    const { listKnowledge } = require("./store");
    const result = listKnowledge(businessId, { includeInactive: false });
    const items = Array.isArray(result) ? result : (result.items || []);
    
    let totalEmbedded = 0;
    for (const item of items) {
        const result = await embedKnowledgeItem(businessId, item.knowledge_id, item.content, item.title);
        totalEmbedded += result.embedded;
    }
    return { embedded: totalEmbedded, items: items.length };
}

module.exports = {
    getEmbeddingProvider,
    initEmbeddingTables,
    embedKnowledgeItem,
    deleteKnowledgeEmbeddings,
    vectorSearchKnowledge,
    hybridSearchKnowledge,
    rebuildBusinessEmbeddings,
    chunkText,
    cosineSimilarity,
};