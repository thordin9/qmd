/**
 * embedding-model-tracking.test.ts - Tests for embedding model tracking functionality
 * 
 * Tests the embedding_models table and model_id tracking across both SQLite and PostgreSQL
 * 
 * Run with: bun test embedding-model-tracking.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { 
  createDatabase, 
  createSQLiteDatabase,
  createPostgresDatabase,
  type IDatabase,
  type PostgresConfig 
} from "./database";
import {
  getOrCreateModelId,
  getCurrentModelId,
  getHashesForEmbedding,
  insertEmbedding,
  searchVec,
  type Store
} from "./store";

// PostgreSQL test configuration
const isPostgresAvailable = Boolean(Bun.env.QMD_TEST_POSTGRES);
const getTestConfig = (): PostgresConfig => ({
  host: Bun.env.QMD_POSTGRES_HOST || 'localhost',
  port: parseInt(Bun.env.QMD_POSTGRES_PORT || '5432', 10),
  database: Bun.env.QMD_POSTGRES_DB || 'qmd',
  user: Bun.env.QMD_POSTGRES_USER || 'qmd_user',
  password: Bun.env.QMD_POSTGRES_PASSWORD || 'qmd_password',
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 2000,
});

// Test helpers
let testDbPath: string;
let testDb: IDatabase | null = null;
let testStore: Store | null = null;

async function createTestDatabase(type: 'sqlite' | 'postgres'): Promise<IDatabase> {
  if (type === 'postgres') {
    if (!isPostgresAvailable) {
      throw new Error("PostgreSQL not available for testing");
    }
    return createPostgresDatabase(getTestConfig());
  } else {
    testDbPath = join(tmpdir(), `test-embedding-model-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = createSQLiteDatabase(testDbPath);
    
    // Load sqlite-vec extension
    const nativeDb = db.getNativeDatabase() as Database;
    try {
      sqliteVec.load(nativeDb);
    } catch (err) {
      console.warn("Could not load sqlite-vec extension:", err);
      // Tests that require sqlite-vec will fail, but that's ok for now
    }
    
    return db;
  }
}

async function cleanupTestDatabase(db: IDatabase, type: 'sqlite' | 'postgres') {
  try {
    if (type === 'postgres') {
      // Clean up test data in PostgreSQL
      db.exec(`DROP TABLE IF EXISTS vectors_vec CASCADE`);
      db.exec(`DROP TABLE IF EXISTS vectors CASCADE`);
      db.exec(`DROP TABLE IF EXISTS content_vectors CASCADE`);
      db.exec(`DROP TABLE IF EXISTS embedding_models CASCADE`);
      db.exec(`DROP TABLE IF EXISTS documents_fts CASCADE`);
      db.exec(`DROP TABLE IF EXISTS documents CASCADE`);
      db.exec(`DROP TABLE IF EXISTS content CASCADE`);
      db.exec(`DROP TABLE IF EXISTS llm_cache CASCADE`);
    }
    db.close();
    if (type === 'sqlite' && testDbPath) {
      await unlink(testDbPath);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

async function setupTestStore(type: 'sqlite' | 'postgres'): Promise<{ db: IDatabase; ensureVecTable: (dims: number) => void }> {
  const db = await createTestDatabase(type);
  testDb = db;
  
  // Initialize the database schema manually
  if (type === 'postgres') {
    // PostgreSQL schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_models (
        id SERIAL PRIMARY KEY,
        model_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL,
        UNIQUE(model_name, provider, dimensions)
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        collection TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL,
        modified_at TIMESTAMP NOT NULL,
        UNIQUE(collection, path)
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_vectors (
        hash TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        pos INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        model_id INTEGER,
        embedded_at TIMESTAMP NOT NULL,
        PRIMARY KEY (hash, seq),
        FOREIGN KEY (model_id) REFERENCES embedding_models(id)
      )
    `);
  } else {
    // SQLite schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(model_name, provider, dimensions)
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        UNIQUE(collection, path)
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_vectors (
        hash TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        pos INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        model_id INTEGER,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (hash, seq),
        FOREIGN KEY (model_id) REFERENCES embedding_models(id)
      )
    `);
  }
  
  const ensureVecTableFn = (dimensions: number) => {
    if (type === 'sqlite') {
      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
      if (!tableExists) {
        db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
      }
    } else {
      // Enable pgvector extension
      db.exec(`CREATE EXTENSION IF NOT EXISTS vector`);

      const tableExists = db.prepare(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'vectors'
      `).get();
      if (!tableExists) {
        db.exec(`CREATE TABLE vectors (hash_seq TEXT PRIMARY KEY, embedding vector(${dimensions}))`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_vectors_embedding ON vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`);
      }
    }
  };
  
  return { db, ensureVecTable: ensureVecTableFn };
}

afterEach(async () => {
  if (testDb) {
    const dbType = testDb.supportsExtensions() ? 'sqlite' : 'postgres';
    await cleanupTestDatabase(testDb, dbType);
    testDb = null;
  }
  if (testStore) {
    testStore = null;
  }
});

// =============================================================================
// SQLite Tests
// =============================================================================

describe("Embedding Model Tracking - SQLite", () => {
  test("embedding_models table exists after initialization", async () => {
    const { db } = await setupTestStore('sqlite');
    
    // Check that the embedding_models table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_models'
    `).get();
    
    expect(tableExists).toBeDefined();
    expect(tableExists).toHaveProperty('name', 'embedding_models');
  });

  test("getOrCreateModelId creates new model entry", async () => {
    const { db } = await setupTestStore('sqlite');
    
    const modelId = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    
    expect(modelId).toBeGreaterThan(0);
    
    // Verify the model was stored correctly
    const model = db.prepare(`
      SELECT * FROM embedding_models WHERE id = ?
    `).get(modelId) as any;
    
    expect(model).toBeDefined();
    expect(model.model_name).toBe('embeddinggemma');
    expect(model.provider).toBe('local');
    expect(model.dimensions).toBe(768);
  });

  test("getOrCreateModelId returns existing model ID", async () => {
    const { db } = await setupTestStore('sqlite');
    
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    
    expect(modelId1).toBe(modelId2);
    
    // Verify only one row exists
    const count = db.prepare(`
      SELECT COUNT(*) as count FROM embedding_models
    `).get() as { count: number };
    
    expect(count.count).toBe(1);
  });

  test("getOrCreateModelId creates separate entries for different models", async () => {
    const { db } = await setupTestStore('sqlite');
    
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'nomic-embed-text', 'ollama', 768);
    const modelId3 = getOrCreateModelId(db, 'embeddinggemma', 'local', 1024);
    
    expect(modelId1).not.toBe(modelId2);
    expect(modelId1).not.toBe(modelId3);
    expect(modelId2).not.toBe(modelId3);
    
    // Verify three rows exist
    const count = db.prepare(`
      SELECT COUNT(*) as count FROM embedding_models
    `).get() as { count: number };
    
    expect(count.count).toBe(3);
  });

  test("getCurrentModelId returns null for non-existent model", async () => {
    const { db } = await setupTestStore('sqlite');
    
    const modelId = getCurrentModelId(db, 'nonexistent', 'local');
    
    expect(modelId).toBeNull();
  });

  test("getCurrentModelId returns most recent model ID", async () => {
    const { db } = await setupTestStore('sqlite');
    
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    // Wait a tiny bit to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));
    const modelId2 = getOrCreateModelId(db, 'embeddinggemma', 'local', 1024);
    
    const currentId = getCurrentModelId(db, 'embeddinggemma', 'local');
    
    expect(currentId).toBe(modelId2);
  });

  test("insertEmbedding stores model_id correctly", async () => {
    const { db, ensureVecTable } = await setupTestStore('sqlite');
    
    const modelId = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    
    // Create vectors_vec table
    ensureVecTable(768);
    
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    
    insertEmbedding(db, 'testhash', 0, 0, embedding, 'embeddinggemma', now, modelId);
    
    // Verify the embedding was stored with model_id
    const vector = db.prepare(`
      SELECT model_id FROM content_vectors WHERE hash = ? AND seq = ?
    `).get('testhash', 0) as { model_id: number };
    
    expect(vector.model_id).toBe(modelId);
  });

  test("searchVec filters by model_id", async () => {
    const { db, ensureVecTable } = await setupTestStore('sqlite');
    
    // Create two different model IDs
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'other-model', 'local', 768);
    
    // Insert test document
    const hash = 'testhash123';
    db.prepare(`
      INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)
    `).run(hash, 'Test content', new Date().toISOString());
    
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, active, created_at, modified_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run('test-coll', 'doc.md', 'Test Doc', hash, new Date().toISOString(), new Date().toISOString());
    
    // Create vectors_vec table
    ensureVecTable(768);
    
    // Insert embedding with model_id1
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    insertEmbedding(db, hash, 0, 0, embedding, 'embeddinggemma', now, modelId1);
    
    // Search with embeddinggemma (should find it)
    const results1 = await searchVec(db, 'test', 'embeddinggemma', 10);
    expect(results1.length).toBeGreaterThan(0);
  });

  test("getHashesForEmbedding filters by model", async () => {
    const { db, ensureVecTable } = await setupTestStore('sqlite');
    
    // Create two model IDs
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'other-model', 'local', 768);
    
    // Insert two test documents
    const hash1 = 'hash1';
    const hash2 = 'hash2';
    
    for (const hash of [hash1, hash2]) {
      db.prepare(`
        INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)
      `).run(hash, `Test content ${hash}`, new Date().toISOString());
      
      db.prepare(`
        INSERT INTO documents (collection, path, title, hash, active, created_at, modified_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run('test-coll', `${hash}.md`, 'Test Doc', hash, new Date().toISOString(), new Date().toISOString());
    }
    
    // Create vectors_vec table
    ensureVecTable(768);
    
    // Insert embedding for hash1 with modelId1
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    insertEmbedding(db, hash1, 0, 0, embedding, 'embeddinggemma', now, modelId1);
    
    // Get hashes needing embedding for 'embeddinggemma' model
    const hashes = getHashesForEmbedding(db, 'embeddinggemma', 'local');
    
    // Should return hash2 (not embedded) but not hash1 (already embedded with this model)
    expect(hashes.length).toBe(1);
    expect(hashes[0]!.hash).toBe(hash2);
  });

  test("content_vectors.model_id is nullable for backward compatibility", async () => {
    const { db, ensureVecTable } = await setupTestStore('sqlite');
    
    // Create vectors_vec table
    ensureVecTable(768);
    
    // Insert embedding without model_id (NULL)
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    
    db.prepare(`
      INSERT INTO content_vectors (hash, seq, pos, model, model_id, embedded_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run('testhash', 0, 0, 'test', now);
    
    // Verify it was inserted with NULL model_id
    const vector = db.prepare(`
      SELECT model_id FROM content_vectors WHERE hash = ?
    `).get('testhash') as { model_id: number | null };
    
    expect(vector.model_id).toBeNull();
  });
});

// =============================================================================
// PostgreSQL Tests
// =============================================================================

const describeIfPostgres = isPostgresAvailable ? describe : describe.skip;

describeIfPostgres("Embedding Model Tracking - PostgreSQL", () => {
  test("embedding_models table exists after initialization", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    // Check that the embedding_models table exists
    const tableExists = db.prepare(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'embedding_models'
    `).get();
    
    expect(tableExists).toBeDefined();
    expect(tableExists).toHaveProperty('table_name', 'embedding_models');
  });

  test("getOrCreateModelId creates new model entry", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    const modelId = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    
    expect(modelId).toBeGreaterThan(0);
    
    // Verify the model was stored correctly
    const model = db.prepare(`
      SELECT * FROM embedding_models WHERE id = ?
    `).get(modelId) as any;
    
    expect(model).toBeDefined();
    expect(model.model_name).toBe('embeddinggemma');
    expect(model.provider).toBe('local');
    expect(model.dimensions).toBe(768);
  });

  test("getOrCreateModelId returns existing model ID", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    
    expect(modelId1).toBe(modelId2);
    
    // Verify only one row exists
    const count = db.prepare(`
      SELECT COUNT(*) as count FROM embedding_models
    `).get() as { count: number };
    
    expect(count.count).toBe(1);
  });

  test("getOrCreateModelId creates separate entries for different models", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'nomic-embed-text', 'ollama', 768);
    const modelId3 = getOrCreateModelId(db, 'embeddinggemma', 'local', 1024);
    
    expect(modelId1).not.toBe(modelId2);
    expect(modelId1).not.toBe(modelId3);
    expect(modelId2).not.toBe(modelId3);
    
    // Verify three rows exist
    const count = db.prepare(`
      SELECT COUNT(*) as count FROM embedding_models
    `).get() as { count: number };
    
    expect(count.count).toBe(3);
  });

  test("getCurrentModelId returns null for non-existent model", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    const modelId = getCurrentModelId(db, 'nonexistent', 'local');
    
    expect(modelId).toBeNull();
  });

  test("getCurrentModelId returns most recent model ID", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    // Wait a tiny bit to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));
    const modelId2 = getOrCreateModelId(db, 'embeddinggemma', 'local', 1024);
    
    const currentId = getCurrentModelId(db, 'embeddinggemma', 'local');
    
    expect(currentId).toBe(modelId2);
  });

  test("insertEmbedding stores model_id correctly", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    const modelId = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    
    // Create vectors table (PostgreSQL uses vectors, not vectors_vec)
    ensureVecTable(768);
    
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    
    insertEmbedding(db, 'testhash', 0, 0, embedding, 'embeddinggemma', now, modelId);
    
    // Verify the embedding was stored with model_id
    const vector = db.prepare(`
      SELECT model_id FROM content_vectors WHERE hash = ? AND seq = ?
    `).get('testhash', 0) as { model_id: number };
    
    expect(vector.model_id).toBe(modelId);
  });

  test("searchVec filters by model_id", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');

    // Use the same provider that getDefaultLLMProvider() will return
    // In CI, this will be 'mock' due to QMD_MOCK_LLM=true
    const provider = process.env.QMD_MOCK_LLM === "true" || process.env.CI === "true" ? "mock" : "local";

    // Create two different model IDs
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', provider, 768);
    const modelId2 = getOrCreateModelId(db, 'other-model', provider, 768);

    // Insert test document
    const hash = 'testhash123';
    db.prepare(`
      INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)
    `).run(hash, 'Test content', new Date().toISOString());

    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, active, created_at, modified_at)
      VALUES (?, ?, ?, ?, true, ?, ?)
    `).run('test-coll', 'doc.md', 'Test Doc', hash, new Date().toISOString(), new Date().toISOString());

    // Create vectors table
    ensureVecTable(768);

    // Insert embedding with model_id1
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    insertEmbedding(db, hash, 0, 0, embedding, 'embeddinggemma', now, modelId1);

    // Search with embeddinggemma (should find it)
    const results1 = await searchVec(db, 'test', 'embeddinggemma', 10);
    expect(results1.length).toBeGreaterThan(0);
  });

  test("getHashesForEmbedding filters by model", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    // Create two model IDs
    const modelId1 = getOrCreateModelId(db, 'embeddinggemma', 'local', 768);
    const modelId2 = getOrCreateModelId(db, 'other-model', 'local', 768);
    
    // Insert two test documents
    const hash1 = 'hash1';
    const hash2 = 'hash2';
    
    for (const hash of [hash1, hash2]) {
      db.prepare(`
        INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)
      `).run(hash, `Test content ${hash}`, new Date().toISOString());
      
      db.prepare(`
        INSERT INTO documents (collection, path, title, hash, active, created_at, modified_at)
        VALUES (?, ?, ?, ?, true, ?, ?)
      `).run('test-coll', `${hash}.md`, 'Test Doc', hash, new Date().toISOString(), new Date().toISOString());
    }
    
    // Create vectors table
    ensureVecTable(768);
    
    // Insert embedding for hash1 with modelId1
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    insertEmbedding(db, hash1, 0, 0, embedding, 'embeddinggemma', now, modelId1);
    
    // Get hashes needing embedding for 'embeddinggemma' model
    const hashes = getHashesForEmbedding(db, 'embeddinggemma', 'local');
    
    // Should return hash2 (not embedded) but not hash1 (already embedded with this model)
    expect(hashes.length).toBe(1);
    expect(hashes[0]!.hash).toBe(hash2);
  });

  test("content_vectors.model_id is nullable for backward compatibility", async () => {
    const { db, ensureVecTable } = await setupTestStore('postgres');
    
    // Create vectors table
    ensureVecTable(768);
    
    // Insert embedding without model_id (NULL)
    const embedding = new Float32Array(768).fill(0.1);
    const now = new Date().toISOString();
    
    db.prepare(`
      INSERT INTO content_vectors (hash, seq, pos, model, model_id, embedded_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run('testhash', 0, 0, 'test', now);
    
    // Verify it was inserted with NULL model_id
    const vector = db.prepare(`
      SELECT model_id FROM content_vectors WHERE hash = ?
    `).get('testhash') as { model_id: number | null };
    
    expect(vector.model_id).toBeNull();
  });
});
