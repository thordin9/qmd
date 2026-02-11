/**
 * Database Abstraction Layer
 * 
 * This module provides a database abstraction interface that allows QMD to work
 * with different database implementations while maintaining SQLite as the default.
 * 
 * The abstraction layer provides:
 * - IDatabase: Core database interface for connections and operations
 * - IStatement: Interface for prepared statements
 * - SQLiteDatabase: Default SQLite implementation using bun:sqlite
 * 
 * ## Design Goals
 * 
 * 1. **Database Independence**: Application code uses IDatabase interface,
 *    not SQLite-specific APIs
 * 2. **Type Safety**: Strong TypeScript types prevent common errors
 * 3. **Extension Support**: Access to native database for extensions like sqlite-vec
 * 4. **Performance**: Zero-cost abstraction - direct passthrough to native APIs
 * 
 * ## Usage
 * 
 * ```typescript
 * import { createDatabase, createSQLiteDatabase } from './database';
 * 
 * // Using factory function
 * const db = createDatabase('sqlite', { path: '/path/to/db.sqlite' });
 * 
 * // Using convenience function
 * const db = createSQLiteDatabase('/path/to/db.sqlite');
 * 
 * // Prepare and execute queries
 * const stmt = db.prepare('SELECT * FROM documents WHERE id = ?');
 * const doc = stmt.get(123);
 * const docs = stmt.all();
 * 
 * // Execute mutations
 * const insertStmt = db.prepare('INSERT INTO documents (title) VALUES (?)');
 * const result = insertStmt.run('My Document');
 * console.log(`Inserted row ${result.lastInsertRowid}`);
 * 
 * // Execute raw SQL
 * db.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY)');
 * 
 * // Access native database for extensions (if supported)
 * if (db.supportsExtensions()) {
 *   const nativeDb = db.getNativeDatabase();
 *   sqliteVec.load(nativeDb);
 * }
 * 
 * // Clean up
 * db.close();
 * ```
 * 
 * **Note**: On macOS, this module automatically configures Homebrew-installed
 * SQLite when loaded to ensure extensions like sqlite-vec work properly.
 * No additional setup is required.
 * 
 * ## Adding New Database Backends
 * 
 * To add support for a new database:
 * 1. Create a class implementing IDatabase
 * 2. Create a statement class implementing IStatement
 * 3. Add the new type to DatabaseType union
 * 4. Update the createDatabase factory
 * 
 * See ARCHITECTURE.md for detailed instructions.
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

// =============================================================================
// SQLite Configuration
// =============================================================================

/**
 * Configure custom SQLite library from Homebrew if available.
 * This is called automatically when the module loads to ensure sqlite-vec
 * extensions work properly on macOS with Homebrew-installed SQLite.
 */
function configureSQLiteFromBrewPrefix(): void {
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    // Use BREW_PREFIX for non-standard Homebrew installs (common on corporate Macs).
    const brewPrefix = Bun.env.BREW_PREFIX || Bun.env.HOMEBREW_PREFIX;
    if (brewPrefix) {
      // Homebrew can place SQLite in opt/sqlite (keg-only) or directly under the prefix.
      candidates.push(`${brewPrefix}/opt/sqlite/lib/libsqlite3.dylib`);
      candidates.push(`${brewPrefix}/lib/libsqlite3.dylib`);
    } else {
      candidates.push("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
      candidates.push("/usr/local/opt/sqlite/lib/libsqlite3.dylib");
    }
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).size > 0) {
        Database.setCustomSQLite(candidate);
        return;
      }
    } catch { }
  }
}

// Configure SQLite when module loads
configureSQLiteFromBrewPrefix();

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Result of a query that returns a single row.
 * Returns null when no rows match.
 */
export type QueryResult = Record<string, unknown> | null;

/**
 * Result of a query that returns multiple rows
 */
export type QueryResults = Array<Record<string, unknown>>;

/**
 * Result of a mutation query (INSERT, UPDATE, DELETE)
 */
export interface MutationResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Database query binding value types
 */
export type DatabaseValue = string | number | bigint | boolean | null | Uint8Array | Float32Array;

/**
 * Prepared statement interface
 */
export interface IStatement {
  /**
   * Execute the statement and return a single row
   */
  get(...params: DatabaseValue[]): QueryResult;
  
  /**
   * Execute the statement and return all rows
   */
  all(...params: DatabaseValue[]): QueryResults;
  
  /**
   * Execute the statement and return mutation result
   */
  run(...params: DatabaseValue[]): MutationResult;
  
  /**
   * Finalize the statement and free resources
   */
  finalize(): void;
}

/**
 * Core database interface
 */
export interface IDatabase {
  /**
   * Prepare a SQL statement for execution
   */
  prepare(sql: string): IStatement;
  
  /**
   * Execute SQL directly without preparation
   */
  exec(sql: string): void;
  
  /**
   * Close the database connection
   */
  close(): void;
  
  /**
   * Get the underlying native database object (for extensions like sqlite-vec)
   * @returns The native database object for this implementation
   */
  getNativeDatabase(): unknown;
  
  /**
   * Check if this database supports loading extensions
   * @returns true if extensions can be loaded, false otherwise
   */
  supportsExtensions(): boolean;
}

/**
 * Transaction callback function
 */
export type TransactionCallback<T> = (db: IDatabase) => T;

/**
 * Database factory options
 */
export interface DatabaseOptions {
  /**
   * Path to the database file (for file-based databases like SQLite)
   */
  path: string;
  
  /**
   * Additional configuration options specific to the database implementation
   */
  config?: Record<string, unknown>;
}

// =============================================================================
// SQLite Implementation
// =============================================================================

/**
 * SQLite-specific statement wrapper
 */
class SQLiteStatement implements IStatement {
  constructor(private statement: ReturnType<Database["prepare"]>) {}
  
  get(...params: DatabaseValue[]): QueryResult {
    return this.statement.get(...params) as QueryResult;
  }
  
  all(...params: DatabaseValue[]): QueryResults {
    return this.statement.all(...params) as QueryResults;
  }
  
  run(...params: DatabaseValue[]): MutationResult {
    const result = this.statement.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }
  
  finalize(): void {
    this.statement.finalize();
  }
}

/**
 * SQLite database implementation using bun:sqlite
 */
export class SQLiteDatabase implements IDatabase {
  private db: Database;
  
  constructor(path: string) {
    this.db = new Database(path);
  }
  
  prepare(sql: string): IStatement {
    return new SQLiteStatement(this.db.prepare(sql));
  }
  
  exec(sql: string): void {
    this.db.exec(sql);
  }
  
  close(): void {
    this.db.close();
  }
  
  getNativeDatabase(): Database {
    return this.db;
  }
  
  supportsExtensions(): boolean {
    return true; // SQLite supports extensions
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Database type identifier
 */
export type DatabaseType = 'sqlite';

/**
 * Create a database instance
 * 
 * @param type - Database type ('sqlite' is currently the only supported type)
 * @param options - Database configuration options
 * @returns Database instance implementing IDatabase interface
 */
export function createDatabase(type: DatabaseType, options: DatabaseOptions): IDatabase {
  switch (type) {
    case 'sqlite':
      return new SQLiteDatabase(options.path);
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
}

/**
 * Create a SQLite database (convenience function)
 * 
 * @param path - Path to the SQLite database file
 * @returns SQLite database instance
 */
export function createSQLiteDatabase(path: string): IDatabase {
  return new SQLiteDatabase(path);
}
