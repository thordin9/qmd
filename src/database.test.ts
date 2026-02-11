/**
 * database.test.ts - Tests for the database abstraction layer
 * 
 * Run with: bun test database.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { 
  createDatabase, 
  createSQLiteDatabase, 
  type IDatabase,
  type DatabaseType 
} from "./database";

let testDbPath: string;
let db: IDatabase;

beforeEach(() => {
  testDbPath = join(tmpdir(), `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
});

afterEach(async () => {
  try {
    db?.close();
    await unlink(testDbPath);
  } catch {
    // Ignore cleanup errors
  }
});

describe("Database Abstraction Layer", () => {
  describe("Factory Functions", () => {
    test("createDatabase creates a SQLite database", () => {
      db = createDatabase('sqlite', { path: testDbPath });
      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.exec).toBe('function');
      expect(typeof db.close).toBe('function');
    });

    test("createSQLiteDatabase creates a SQLite database", () => {
      db = createSQLiteDatabase(testDbPath);
      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.exec).toBe('function');
      expect(typeof db.close).toBe('function');
    });

    test("createDatabase throws on unsupported type", () => {
      expect(() => {
        createDatabase('postgres' as DatabaseType, { path: testDbPath });
      }).toThrow("Unsupported database type");
    });
  });

  describe("Basic Operations", () => {
    test("exec creates tables", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test'");
      const result = stmt.get();
      expect(result).toBeDefined();
      expect((result as any).name).toBe('test');
    });

    test("prepare and run inserts data", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("INSERT INTO test (name) VALUES (?)");
      const result = stmt.run('Alice');
      
      expect(result.changes).toBe(1);
      expect(Number(result.lastInsertRowid)).toBe(1);
    });

    test("prepare and get retrieves single row", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      db.prepare("INSERT INTO test (name) VALUES (?)").run('Alice');
      
      const stmt = db.prepare("SELECT * FROM test WHERE name = ?");
      const result = stmt.get('Alice');
      
      expect(result).toBeDefined();
      expect((result as any).name).toBe('Alice');
      expect((result as any).id).toBe(1);
    });

    test("prepare and all retrieves multiple rows", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      db.prepare("INSERT INTO test (name) VALUES (?)").run('Alice');
      db.prepare("INSERT INTO test (name) VALUES (?)").run('Bob');
      db.prepare("INSERT INTO test (name) VALUES (?)").run('Charlie');
      
      const stmt = db.prepare("SELECT * FROM test ORDER BY id");
      const results = stmt.all();
      
      expect(results).toHaveLength(3);
      expect((results[0] as any).name).toBe('Alice');
      expect((results[1] as any).name).toBe('Bob');
      expect((results[2] as any).name).toBe('Charlie');
    });

    test("get returns null for no match", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("SELECT * FROM test WHERE name = ?");
      const result = stmt.get('NonExistent');
      
      expect(result).toBeNull();
    });

    test("all returns empty array for no matches", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("SELECT * FROM test WHERE name = ?");
      const results = stmt.all('NonExistent');
      
      expect(results).toEqual([]);
    });
  });

  describe("Parameter Binding", () => {
    test("supports string parameters", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (value TEXT)");
      
      db.prepare("INSERT INTO test (value) VALUES (?)").run('hello');
      const result = db.prepare("SELECT value FROM test").get();
      
      expect((result as any).value).toBe('hello');
    });

    test("supports number parameters", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (value INTEGER)");
      
      db.prepare("INSERT INTO test (value) VALUES (?)").run(42);
      const result = db.prepare("SELECT value FROM test").get();
      
      expect((result as any).value).toBe(42);
    });

    test("supports boolean parameters", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (value INTEGER)");
      
      db.prepare("INSERT INTO test (value) VALUES (?)").run(true);
      db.prepare("INSERT INTO test (value) VALUES (?)").run(false);
      const results = db.prepare("SELECT value FROM test ORDER BY rowid").all();
      
      expect((results[0] as any).value).toBe(1);
      expect((results[1] as any).value).toBe(0);
    });

    test("supports null parameters", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (value TEXT)");
      
      db.prepare("INSERT INTO test (value) VALUES (?)").run(null);
      const result = db.prepare("SELECT value FROM test").get();
      
      expect((result as any).value).toBeNull();
    });

    test("supports multiple parameters", () => {
      db = createSQLiteDatabase(testDbPath);
      db.exec("CREATE TABLE test (name TEXT, age INTEGER, active INTEGER)");
      
      db.prepare("INSERT INTO test (name, age, active) VALUES (?, ?, ?)").run('Alice', 30, true);
      const result = db.prepare("SELECT * FROM test").get();
      
      expect((result as any).name).toBe('Alice');
      expect((result as any).age).toBe(30);
      expect((result as any).active).toBe(1);
    });
  });

  describe("Native Database Access", () => {
    test("getNativeDatabase returns underlying database", () => {
      db = createSQLiteDatabase(testDbPath);
      const nativeDb = db.getNativeDatabase();
      
      expect(nativeDb).toBeDefined();
      expect(typeof (nativeDb as any).exec).toBe('function');
    });

    test("supportsExtensions returns true for SQLite", () => {
      db = createSQLiteDatabase(testDbPath);
      expect(db.supportsExtensions()).toBe(true);
    });
  });

  describe("Close", () => {
    test("close succeeds without error", () => {
      db = createSQLiteDatabase(testDbPath);
      expect(() => db.close()).not.toThrow();
    });

    test("operations after close throw error", () => {
      db = createSQLiteDatabase(testDbPath);
      db.close();
      
      expect(() => {
        db.prepare("SELECT 1");
      }).toThrow();
    });
  });
});
