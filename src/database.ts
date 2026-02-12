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
  path?: string;
  
  /**
   * Additional configuration options specific to the database implementation
   */
  config?: Record<string, unknown>;
}

/**
 * PostgreSQL connection configuration
 */
export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  max?: number; // maximum number of connections in pool
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
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
// PostgreSQL Implementation
// =============================================================================

/**
 * PostgreSQL-specific statement wrapper
 * 
 * Uses psql via Bun.spawnSync for synchronous operations.
 * This allows PostgreSQL to work with the synchronous IStatement interface.
 */
class PostgresStatement implements IStatement {
  constructor(
    private config: PostgresConfig,
    private sql: string
  ) {}
  
  private executePsql(sql: string, params: DatabaseValue[] = []): { rows: QueryResults; stdout: string; stderr: string; exitCode: number } {
    // Build psql connection string (without password for security)
    const connStr = `postgresql://${this.config.user}@${this.config.host}:${this.config.port}/${this.config.database}`;
    
    // Substitute parameters in SQL (simple positional replacement)
    let parameterizedSql = sql;
    const substitutions: Array<{ placeholder: string; value: string; position: number }> = [];
    
    // Find all placeholders and their positions
    const placeholderRegex = /\$(\d+)\b/g;
    let match;
    while ((match = placeholderRegex.exec(sql)) !== null) {
      const paramIndex = Number(match[1]) - 1;
      if (paramIndex >= 0 && paramIndex < params.length) {
        substitutions.push({
          placeholder: match[0],
          value: '', // Will be filled below
          position: match.index,
        });
      }
    }
    
    // Sort by position (descending) so we can replace from end to start
    substitutions.sort((a, b) => b.position - a.position);
    
    // Build SQL by replacing placeholders from end to start
    for (const sub of substitutions) {
      const paramIndex = Number(sub.placeholder.slice(1)) - 1;
      const param = params[paramIndex];
      let value: string;

      if (param === null || param === undefined) {
        value = 'NULL';
      } else if (typeof param === 'string') {
        // Escape single quotes in strings
        value = `'${param.replace(/'/g, "''")}'`;
      } else if (typeof param === 'boolean') {
        value = param ? 'true' : 'false';
      } else if (
        Array.isArray(param) ||
        param instanceof Float32Array ||
        param instanceof Float64Array ||
        param instanceof Int8Array ||
        param instanceof Uint8Array ||
        param instanceof Int16Array ||
        param instanceof Uint16Array ||
        param instanceof Int32Array ||
        param instanceof Uint32Array
      ) {
        // Convert arrays and typed arrays to PostgreSQL array literal
        const elements = Array.from(param as ArrayLike<number>).map((v) => {
          if (v === null || v === undefined) {
            return 'NULL';
          }
          if (typeof v === 'number') {
            return Number.isFinite(v) ? String(v) : 'NULL';
          }
          return String(v);
        });
        value = `'[${elements.join(',')}]'`;
      } else if (typeof param === 'number') {
        value = String(param);
      } else {
        // Fallback for other types
        value = String(param);
      }
      
      // Replace this specific placeholder occurrence
      parameterizedSql = 
        parameterizedSql.slice(0, sub.position) +
        value +
        parameterizedSql.slice(sub.position + sub.placeholder.length);
    }
    
    // Execute via psql with -A (unaligned) -F '|' (pipe delimiter) and get column headers
    const result = Bun.spawnSync(['psql', connStr, '-A', '-F', '|', '--no-psqlrc', '-c', parameterizedSql], {
      env: {
        ...process.env,
        PGPASSWORD: this.config.password,
        PAGER: '', // Disable pager
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    
    // Parse psql output: first line is column names, then data rows
    const lines = stdout.split('\n');
    const rows: QueryResults = [];
    
    // Find the header line and data lines
    let headerIdx = -1;
    
    // Find header (first non-empty line)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] && !lines[i].startsWith('(')) {
        headerIdx = i;
        break;
      }
    }
    
    if (headerIdx >= 0) {
      const headers = lines[headerIdx].split('|');
      
      // Find where data ends (before row count line)
      let dataEndIdx = lines.length;
      for (let i = headerIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('(') && lines[i].includes('row')) {
          dataEndIdx = i;
          break;
        }
      }
      
      // Process data lines (everything between header and row count)
      for (let i = headerIdx + 1; i < dataEndIdx; i++) {
        const line = lines[i];
        const values = line === '' ? [] : line.split('|');
        const row: Record<string, unknown> = {};
        
        for (let j = 0; j < headers.length; j++) {
          const header = headers[j];
          let value: unknown = j < values.length ? values[j] : '';
          
          // Convert to appropriate type based on psql output
          if (value === '' || value === null) {
            value = null;
          } else if (value === 't') {
            value = true;
          } else if (value === 'f') {
            value = false;
          } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
            // Convert numeric strings to numbers
            // PostgreSQL outputs numbers as strings, so we need to convert them
            value = Number(value);
          }
          
          row[header] = value;
        }
        rows.push(row);
      }
    }
    
    return {
      rows,
      stdout,
      stderr,
      exitCode: result.exitCode,
    };
  }
  
  get(...params: DatabaseValue[]): QueryResult {
    const result = this.executePsql(this.sql, params);
    if (result.exitCode !== 0) {
      throw new Error(`PostgreSQL query failed: ${result.stderr}`);
    }
    
    return result.rows.length > 0 ? result.rows[0] : null;
  }
  
  all(...params: DatabaseValue[]): QueryResults {
    const result = this.executePsql(this.sql, params);
    if (result.exitCode !== 0) {
      throw new Error(`PostgreSQL query failed: ${result.stderr}`);
    }
    
    return result.rows;
  }
  
  run(...params: DatabaseValue[]): MutationResult {
    const result = this.executePsql(this.sql, params);
    if (result.exitCode !== 0) {
      throw new Error(`PostgreSQL query failed: ${result.stderr}`);
    }
    
    // Try to extract row count from output (e.g., "INSERT 0 1" or "UPDATE 3")
    const match = result.stdout.match(/(?:INSERT|UPDATE|DELETE)\s+\d+\s+(\d+)/);
    const changes = match ? parseInt(match[1], 10) : 0;
    
    return {
      changes,
      lastInsertRowid: 0, // PostgreSQL doesn't have this by default
    };
  }
  
  finalize(): void {
    // No resources to clean up for psql-based execution
  }
}

/**
 * PostgreSQL database implementation using psql CLI for synchronous operations
 * 
 * This implementation uses Bun.spawnSync with psql to execute queries synchronously,
 * allowing it to work with the existing synchronous IDatabase interface.
 * 
 * Note: This requires psql to be installed on the system.
 */
export class PostgresDatabase implements IDatabase {
  private config: PostgresConfig;
  
  constructor(config: PostgresConfig) {
    this.config = config;
  }
  
  prepare(sql: string): IStatement {
    return new PostgresStatement(this.config, sql);
  }
  
  exec(sql: string): void {
    const connStr = `postgresql://${this.config.user}@${this.config.host}:${this.config.port}/${this.config.database}`;
    const result = Bun.spawnSync(['psql', connStr, '-c', sql], {
      env: {
        ...process.env,
        PGPASSWORD: this.config.password,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`PostgreSQL exec failed: ${result.stderr.toString()}`);
    }
  }
  
  close(): void {
    // No persistent connection to close with psql approach
  }
  
  getNativeDatabase(): PostgresConfig {
    return this.config;
  }
  
  supportsExtensions(): boolean {
    return false; // pgvector is installed as a PostgreSQL extension, not loaded dynamically
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Database type identifier
 */
export type DatabaseType = 'sqlite' | 'postgres';

/**
 * Create a database instance
 * 
 * @param type - Database type ('sqlite' or 'postgres')
 * @param options - Database configuration options
 * @returns Database instance implementing IDatabase interface
 */
export function createDatabase(type: DatabaseType, options: DatabaseOptions): IDatabase {
  switch (type) {
    case 'sqlite':
      if (!options.path) {
        throw new Error("SQLite requires 'path' in options");
      }
      return new SQLiteDatabase(options.path);
    case 'postgres':
      if (!options.config) {
        throw new Error("PostgreSQL requires 'config' in options");
      }
      return new PostgresDatabase(options.config as PostgresConfig);
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

/**
 * Create a PostgreSQL database (convenience function)
 * 
 * @param config - PostgreSQL connection configuration
 * @returns PostgreSQL database instance
 */
export function createPostgresDatabase(config: PostgresConfig): IDatabase {
  return new PostgresDatabase(config);
}

/**
 * Create a database from environment variables
 * 
 * Supports:
 * - QMD_DB_TYPE: 'sqlite' (default) or 'postgres'
 * - For SQLite: QMD_DB_PATH or INDEX_PATH
 * - For PostgreSQL: QMD_POSTGRES_HOST, QMD_POSTGRES_PORT, QMD_POSTGRES_DB,
 *   QMD_POSTGRES_USER, QMD_POSTGRES_PASSWORD, QMD_POSTGRES_SSL
 */
export function createDatabaseFromEnv(defaultPath?: string): IDatabase {
  const dbType = (Bun.env.QMD_DB_TYPE || 'sqlite') as DatabaseType;
  
  if (dbType === 'postgres') {
    const host = Bun.env.QMD_POSTGRES_HOST || 'localhost';
    const port = parseInt(Bun.env.QMD_POSTGRES_PORT || '5432', 10);
    const database = Bun.env.QMD_POSTGRES_DB || 'qmd';
    const user = Bun.env.QMD_POSTGRES_USER || 'postgres';
    const password = Bun.env.QMD_POSTGRES_PASSWORD || '';
    const ssl = Bun.env.QMD_POSTGRES_SSL === 'true';
    
    return createPostgresDatabase({
      host,
      port,
      database,
      user,
      password,
      ssl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  
  // Default to SQLite
  const path = Bun.env.QMD_DB_PATH || defaultPath;
  if (!path) {
    throw new Error("SQLite requires QMD_DB_PATH or default path");
  }
  return createSQLiteDatabase(path);
}
