# QMD Architecture

## Overview

QMD is built with a modular architecture that separates concerns between data access, search functionality, and user interfaces (CLI and MCP).

## Database Abstraction Layer

QMD uses a database abstraction layer that allows it to work with different database implementations while maintaining SQLite as the default.

### Core Interfaces

#### `IDatabase`

The main database interface that provides:
- `prepare(sql: string): IStatement` - Create prepared statements
- `exec(sql: string): void` - Execute SQL directly
- `close(): void` - Close the database connection
- `getNativeDatabase(): unknown` - Access the underlying database handle for low-level operations (including extension loading when `supportsExtensions()` is `true`)
- `supportsExtensions(): boolean` - Indicate whether this database implementation supports loading and using native extensions

#### `IStatement`

Interface for prepared statements:
- `get(...params: DatabaseValue[]): QueryResult` - Execute and return single row
- `all(...params: DatabaseValue[]): QueryResults` - Execute and return all rows
- `run(...params: DatabaseValue[]): MutationResult` - Execute mutation (INSERT/UPDATE/DELETE)
- `finalize(): void` - Free statement resources

#### `DatabaseValue`

Supported parameter types: `string | number | bigint | boolean | null | Uint8Array | Float32Array`

### Default Implementation: SQLiteDatabase

The default implementation uses Bun's native SQLite driver (`bun:sqlite`) and provides:
- Full SQL support including transactions
- Native performance
- Support for SQLite extensions (e.g., sqlite-vec for vector search)
- WAL mode for concurrent access
- FTS5 for full-text search

### Usage

```typescript
import { createDatabase, createSQLiteDatabase } from './database';

// Using factory function
const db = createDatabase('sqlite', { path: '/path/to/db.sqlite' });

// Using convenience function
const db = createSQLiteDatabase('/path/to/db.sqlite');

// Use the database
const stmt = db.prepare('SELECT * FROM documents WHERE id = ?');
const doc = stmt.get(123);

// Access native database for extensions (e.g., sqlite-vec)
const nativeDb = db.getNativeDatabase();
sqliteVec.load(nativeDb);

// Clean up
db.close();
```

### Extending with New Database Backends

QMD now supports both SQLite and PostgreSQL through its database abstraction layer.

#### PostgreSQL Implementation

PostgreSQL support includes:
- Process-based execution via `psql` CLI tool
- pgvector extension for vector similarity search
- Compatible schema with SQLite for seamless migration
- Synchronous operations using Bun.spawnSync (no async interface needed)

**Configuration:**

```typescript
import { createPostgresDatabase, createDatabaseFromEnv } from './database';

// Explicit configuration
const db = createPostgresDatabase({
  host: 'localhost',
  port: 5432,
  database: 'qmd',
  user: 'qmd_user',
  password: 'qmd_password',
  ssl: false,
});

// From environment variables
const db = createDatabaseFromEnv(); // Reads QMD_DB_TYPE, QMD_POSTGRES_* vars
```

**Key Differences from SQLite:**

1. **Parameter Binding:** PostgreSQL uses `$1, $2, $3` instead of `?` for placeholders
2. **Vector Extension:** Uses pgvector instead of sqlite-vec
3. **Full-Text Search:** Uses GIN indexes with to_tsvector instead of FTS5
4. **Connection Model:** Each query spawns a new psql process (no persistent connections)
5. **Execution:** Uses psql CLI via Bun.spawnSync for synchronous operations

#### Adding Other Database Backends

To add support for a new database backend:

1. Create a class implementing `IDatabase` interface
2. Create a statement class implementing `IStatement` interface
3. Add the new database type to `DatabaseType` union
4. Update the `createDatabase` factory function

Example:

```typescript
export class CustomDatabase implements IDatabase {
  constructor(private config: CustomConfig) {
    // Initialize connection
  }
  
  prepare(sql: string): IStatement {
    return new CustomStatement(this.client, sql);
  }
  
  exec(sql: string): void {
    this.client.execute(sql);
  }
  
  close(): void {
    this.client.disconnect();
  }
  
  getNativeDatabase(): unknown {
    return this.client;
  }
  
  supportsExtensions(): boolean {
    return false; // or true if dynamic extensions are supported
  }
}

// Update factory
export type DatabaseType = 'sqlite' | 'postgres' | 'custom';

export function createDatabase(type: DatabaseType, options: DatabaseOptions): IDatabase {
  switch (type) {
    case 'sqlite':
      return new SQLiteDatabase(options.path!);
    case 'postgres':
      return new PostgresDatabase(options.config as PostgresConfig);
    case 'custom':
      return new CustomDatabase(options.config as CustomConfig);
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
}
```

## Store Layer

The `Store` type wraps all database operations and provides higher-level functionality:
- Document indexing and retrieval
- Full-text search (FTS5 for SQLite, GIN for PostgreSQL)
- Vector search (sqlite-vec for SQLite, pgvector for PostgreSQL)
- Context management
- LLM result caching
- Cleanup and maintenance operations

The Store uses the `IDatabase` interface internally, making it database-agnostic. The implementation automatically adapts to the underlying database type for features like:
- Full-text search queries (FTS5 vs GIN syntax)
- Vector operations (sqlite-vec vs pgvector)
- Schema initialization (SQLite vs PostgreSQL DDL)

## Benefits of Abstraction

1. **Testability** - Easy to mock database operations in tests
2. **Flexibility** - Can switch database backends without changing application code
3. **Type Safety** - Strong TypeScript types prevent common errors
4. **Separation of Concerns** - Database logic isolated from business logic
5. **Extension Points** - Easy to add new database features or backends
6. **Multi-Backend Support** - Same codebase works with SQLite (local) and PostgreSQL (centralized)

## Current Database Schema

### Tables

- **content** - Content-addressable storage (hash → document text)
- **documents** - Virtual file mapping (collection/path → content hash)
- **llm_cache** - LLM API result caching
- **content_vectors** - Embedding metadata
- **vectors_vec** (SQLite) / **vectors** (PostgreSQL) - Vector index for similarity search
- **documents_fts** - Full-text search index (FTS5 for SQLite, GIN for PostgreSQL)

### Indexes

- `idx_documents_collection` - Fast collection filtering
- `idx_documents_hash` - Content deduplication
- `idx_documents_path` - Path lookups

### Extensions

**SQLite:**
- **sqlite-vec** - Vector similarity search with cosine distance
- **FTS5** - Full-text search with Porter stemming and Unicode support

**PostgreSQL:**
- **pgvector** - Vector similarity search with multiple distance metrics
- **pg_trgm** - Fuzzy text matching (optional)
- **GIN indexes** - Fast full-text search with to_tsvector

## LLM Provider Abstraction

QMD supports multiple LLM providers for embeddings, query expansion, and reranking through a pluggable provider system controlled by the `QMD_LLM_PROVIDER` environment variable:

### Providers

1. **Local (default)** - Uses node-llama-cpp with GGUF models
   - Models: embeddinggemma (300MB), qwen3-reranker (600MB), qmd-query-expansion (1.1GB)
   - Models downloaded from HuggingFace and cached locally
   - No API keys required
   - Full privacy - all processing on-device

2. **OpenRouter** - Cloud-based inference via OpenRouter API
   - Requires `QMD_OPENROUTER_API_KEY`
   - Default models: text-embedding-3-small, gpt-4o-mini
   - Configuration: `QMD_OPENROUTER_BASE_URL`, model overrides

3. **Ollama** - Local or remote Ollama inference
   - Default endpoint: http://localhost:11434
   - Default models: nomic-embed-text, llama3.2
   - Optional authentication via `QMD_OLLAMA_API_KEY`
   - Configuration: `QMD_OLLAMA_BASE_URL`, model overrides
   - Models auto-downloaded by Ollama on first use

All providers implement the same `LLM` interface with methods for `embed()`, `embedBatch()`, `generate()`, `expandQuery()`, and `rerank()`, allowing seamless switching between providers.

## Future Considerations

While SQLite is the default and recommended database for QMD's use case, the abstraction layer allows for:
- PostgreSQL backend for centralized deployments
- In-memory database for testing
- Distributed databases for large-scale deployments
- Custom backends for specific requirements
