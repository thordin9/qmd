/**
 * database.postgres.test.ts - Tests for PostgreSQL database implementation
 * 
 * These tests require a PostgreSQL instance with pgvector extension.
 * Run with: docker-compose up -d && bun test database.postgres.test.ts
 * 
 * Set environment variables to override defaults:
 *   QMD_POSTGRES_HOST=localhost
 *   QMD_POSTGRES_PORT=5432
 *   QMD_POSTGRES_DB=qmd
 *   QMD_POSTGRES_USER=qmd_user
 *   QMD_POSTGRES_PASSWORD=qmd_password
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { 
  createDatabase, 
  createPostgresDatabase,
  createDatabaseFromEnv,
  type IDatabase,
  type PostgresConfig 
} from "./database";

// Check if PostgreSQL is available
const isPostgresAvailable = Boolean(Bun.env.QMD_TEST_POSTGRES);

// Only run tests if PostgreSQL is enabled
const describeIfPostgres = isPostgresAvailable ? describe : describe.skip;

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

let db: IDatabase;

describeIfPostgres("PostgreSQL Database Implementation", () => {
  beforeAll(async () => {
    // Wait a bit for postgres to be ready if just started
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterEach(() => {
    try {
      db?.close();
    } catch (err) {
      console.error("Error closing database:", err);
    }
  });

  describe("Factory Functions", () => {
    test("createDatabase creates a PostgreSQL database", () => {
      const config = getTestConfig();
      db = createDatabase('postgres', { config });
      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.exec).toBe('function');
      expect(typeof db.close).toBe('function');
    });

    test("createPostgresDatabase creates a PostgreSQL database", () => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.exec).toBe('function');
      expect(typeof db.close).toBe('function');
    });

    test("createDatabaseFromEnv creates PostgreSQL when QMD_DB_TYPE=postgres", () => {
      const originalDbType = Bun.env.QMD_DB_TYPE;
      const originalHost = Bun.env.QMD_POSTGRES_HOST;
      const originalPort = Bun.env.QMD_POSTGRES_PORT;
      const originalDb = Bun.env.QMD_POSTGRES_DB;
      const originalUser = Bun.env.QMD_POSTGRES_USER;
      const originalPassword = Bun.env.QMD_POSTGRES_PASSWORD;

      try {
        const config = getTestConfig();
        Bun.env.QMD_DB_TYPE = 'postgres';
        Bun.env.QMD_POSTGRES_HOST = config.host;
        Bun.env.QMD_POSTGRES_PORT = config.port.toString();
        Bun.env.QMD_POSTGRES_DB = config.database;
        Bun.env.QMD_POSTGRES_USER = config.user;
        Bun.env.QMD_POSTGRES_PASSWORD = config.password;

        db = createDatabaseFromEnv();
        expect(db).toBeDefined();
        expect(typeof db.prepare).toBe('function');
      } finally {
        // Restore env vars
        if (originalDbType !== undefined) Bun.env.QMD_DB_TYPE = originalDbType;
        else delete Bun.env.QMD_DB_TYPE;
        if (originalHost !== undefined) Bun.env.QMD_POSTGRES_HOST = originalHost;
        else delete Bun.env.QMD_POSTGRES_HOST;
        if (originalPort !== undefined) Bun.env.QMD_POSTGRES_PORT = originalPort;
        else delete Bun.env.QMD_POSTGRES_PORT;
        if (originalDb !== undefined) Bun.env.QMD_POSTGRES_DB = originalDb;
        else delete Bun.env.QMD_POSTGRES_DB;
        if (originalUser !== undefined) Bun.env.QMD_POSTGRES_USER = originalUser;
        else delete Bun.env.QMD_POSTGRES_USER;
        if (originalPassword !== undefined) Bun.env.QMD_POSTGRES_PASSWORD = originalPassword;
        else delete Bun.env.QMD_POSTGRES_PASSWORD;
      }
    });
  });

  describe("Basic Operations", () => {
    beforeEach(() => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
      
      // Clean up test table if it exists
      try {
        db.exec("DROP TABLE IF EXISTS test");
      } catch {
        // Ignore error if table doesn't exist
      }
    });

    test("exec creates tables", () => {
      db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'test'");
      const result = stmt.get();
      expect(result).toBeDefined();
      expect((result as any).tablename).toBe('test');
      
      // Cleanup
      db.exec("DROP TABLE test");
    });

    test("prepare and run inserts data", () => {
      db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("INSERT INTO test (name) VALUES ($1)");
      const result = stmt.run('Alice');
      
      expect(result.changes).toBe(1);
      
      // Cleanup
      db.exec("DROP TABLE test");
    });

    test("prepare and get retrieves single row", () => {
      db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
      db.prepare("INSERT INTO test (name) VALUES ($1)").run('Alice');
      
      const stmt = db.prepare("SELECT * FROM test WHERE name = $1");
      const result = stmt.get('Alice');
      
      expect(result).toBeDefined();
      expect((result as any).name).toBe('Alice');
      expect((result as any).id).toBe(1);
      
      // Cleanup
      db.exec("DROP TABLE test");
    });

    test("prepare and all retrieves multiple rows", () => {
      db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
      db.prepare("INSERT INTO test (name) VALUES ($1)").run('Alice');
      db.prepare("INSERT INTO test (name) VALUES ($1)").run('Bob');
      db.prepare("INSERT INTO test (name) VALUES ($1)").run('Charlie');
      
      const stmt = db.prepare("SELECT * FROM test ORDER BY id");
      const results = stmt.all();
      
      expect(results).toHaveLength(3);
      expect((results[0] as any).name).toBe('Alice');
      expect((results[1] as any).name).toBe('Bob');
      expect((results[2] as any).name).toBe('Charlie');
      
      // Cleanup
      db.exec("DROP TABLE test");
    });

    test("get returns null for no match", () => {
      db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("SELECT * FROM test WHERE name = $1");
      const result = stmt.get('NonExistent');
      
      expect(result).toBeNull();
      
      // Cleanup
      db.exec("DROP TABLE test");
    });

    test("all returns empty array for no matches", () => {
      db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("SELECT * FROM test WHERE name = $1");
      const results = stmt.all('NonExistent');
      
      expect(results).toEqual([]);
      
      // Cleanup
      db.exec("DROP TABLE test");
    });
  });

  describe("Parameter Binding", () => {
    beforeEach(() => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
      
      try {
        db.exec("DROP TABLE IF EXISTS test");
      } catch {
        // Ignore
      }
    });

    test("supports string parameters", () => {
      db.exec("CREATE TABLE test (value TEXT)");
      
      db.prepare("INSERT INTO test (value) VALUES ($1)").run('hello');
      const result = db.prepare("SELECT value FROM test").get();
      
      expect((result as any).value).toBe('hello');
      
      db.exec("DROP TABLE test");
    });

    test("supports number parameters", () => {
      db.exec("CREATE TABLE test (value INTEGER)");
      
      db.prepare("INSERT INTO test (value) VALUES ($1)").run(42);
      const result = db.prepare("SELECT value FROM test").get();
      
      expect((result as any).value).toBe(42);
      
      db.exec("DROP TABLE test");
    });

    test("supports boolean parameters", () => {
      db.exec("CREATE TABLE test (value BOOLEAN)");
      
      db.prepare("INSERT INTO test (value) VALUES ($1)").run(true);
      db.prepare("INSERT INTO test (value) VALUES ($1)").run(false);
      const results = db.prepare("SELECT value FROM test ORDER BY value").all();
      
      expect((results[0] as any).value).toBe(false);
      expect((results[1] as any).value).toBe(true);
      
      db.exec("DROP TABLE test");
    });

    test("supports null parameters", () => {
      db.exec("CREATE TABLE test (value TEXT)");
      
      db.prepare("INSERT INTO test (value) VALUES ($1)").run(null);
      const result = db.prepare("SELECT value FROM test").get();
      
      expect((result as any).value).toBeNull();
      
      db.exec("DROP TABLE test");
    });

    test("supports multiple parameters", () => {
      db.exec("CREATE TABLE test (name TEXT, age INTEGER, active BOOLEAN)");
      
      db.prepare("INSERT INTO test (name, age, active) VALUES ($1, $2, $3)").run('Alice', 30, true);
      const result = db.prepare("SELECT * FROM test").get();
      
      expect((result as any).name).toBe('Alice');
      expect((result as any).age).toBe(30);
      expect((result as any).active).toBe(true);
      
      db.exec("DROP TABLE test");
    });
  });

  describe("pgvector Extension", () => {
    beforeEach(() => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
    });

    test("pgvector extension is available", () => {
      // Create the extension if it doesn't exist
      db.exec("CREATE EXTENSION IF NOT EXISTS vector");
      
      // Verify extension is available
      const stmt = db.prepare("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      const result = stmt.get();
      expect(result).toBeDefined();
      expect((result as any).extname).toBe('vector');
    });

    test("can create vector table with pgvector", () => {
      db.exec("CREATE EXTENSION IF NOT EXISTS vector");
      db.exec("DROP TABLE IF EXISTS test_vectors");
      db.exec("CREATE TABLE test_vectors (id SERIAL PRIMARY KEY, embedding vector(3))");
      
      // Insert a vector
      db.prepare("INSERT INTO test_vectors (embedding) VALUES ($1)").run('[1,2,3]');
      
      // Retrieve the vector
      const result = db.prepare("SELECT embedding FROM test_vectors").get();
      expect(result).toBeDefined();
      
      // Cleanup
      db.exec("DROP TABLE test_vectors");
    });

    test("can perform vector similarity search", () => {
      db.exec("CREATE EXTENSION IF NOT EXISTS vector");
      db.exec("DROP TABLE IF EXISTS test_vectors");
      db.exec("CREATE TABLE test_vectors (id SERIAL PRIMARY KEY, name TEXT, embedding vector(3))");
      
      // Insert test vectors
      db.prepare("INSERT INTO test_vectors (name, embedding) VALUES ($1, $2)").run('a', '[1,0,0]');
      db.prepare("INSERT INTO test_vectors (name, embedding) VALUES ($1, $2)").run('b', '[0,1,0]');
      db.prepare("INSERT INTO test_vectors (name, embedding) VALUES ($1, $2)").run('c', '[0,0,1]');
      
      // Find nearest to [1,0,0] using cosine distance
      const stmt = db.prepare(`
        SELECT name, embedding <=> $1::vector AS distance 
        FROM test_vectors 
        ORDER BY distance 
        LIMIT 1
      `);
      const result = stmt.get('[1,0,0]');
      
      expect(result).toBeDefined();
      expect((result as any).name).toBe('a');
      
      // Cleanup
      db.exec("DROP TABLE test_vectors");
    });
  });

  describe("Native Database Access", () => {
    test("getNativeDatabase returns underlying pool", () => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
      const nativeDb = db.getNativeDatabase();
      
      expect(nativeDb).toBeDefined();
      expect(typeof (nativeDb as any).connect).toBe('function');
      expect(typeof (nativeDb as any).end).toBe('function');
    });

    test("supportsExtensions returns false for PostgreSQL", () => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
      expect(db.supportsExtensions()).toBe(false);
    });
  });

  describe("Close", () => {
    test("close succeeds without error", () => {
      const config = getTestConfig();
      db = createPostgresDatabase(config);
      expect(() => db.close()).not.toThrow();
    });
  });
});
