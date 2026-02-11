# Testing QMD with PostgreSQL + pgvector

This docker-compose setup provides a PostgreSQL instance with the pgvector extension for testing QMD's PostgreSQL support.

## Requirements

- Docker or Docker Compose
- `psql` command-line client (install via `postgresql-client` package)
- Bun runtime

## Quick Start

1. Start PostgreSQL with pgvector:
```bash
docker-compose up -d
```

2. Wait for PostgreSQL to be ready:
```bash
docker-compose ps
# Wait until health status shows "healthy"
```

3. Run the PostgreSQL tests:
```bash
export QMD_TEST_POSTGRES=true
bun test src/database.postgres.test.ts
```

## Environment Variables for Testing

The tests use these default values, which match the docker-compose configuration:

```bash
export QMD_TEST_POSTGRES=true           # Enable PostgreSQL tests
export QMD_POSTGRES_HOST=localhost
export QMD_POSTGRES_PORT=5432
export QMD_POSTGRES_DB=qmd
export QMD_POSTGRES_USER=qmd_user
export QMD_POSTGRES_PASSWORD=qmd_password
```

## Using QMD with the Test Database

You can use QMD with the test PostgreSQL database:

```bash
export QMD_DB_TYPE=postgres
export QMD_POSTGRES_HOST=localhost
export QMD_POSTGRES_PORT=5432
export QMD_POSTGRES_DB=qmd
export QMD_POSTGRES_USER=qmd_user
export QMD_POSTGRES_PASSWORD=qmd_password

# Now use QMD normally
qmd collection add ~/notes --name notes
qmd embed
qmd search "test query"
```

## Accessing PostgreSQL

Connect to the database directly:
```bash
docker-compose exec postgres psql -U qmd_user -d qmd
```

Or from your host:
```bash
psql -h localhost -U qmd_user -d qmd
```

## Stopping and Cleaning Up

```bash
# Stop containers
docker-compose down

# Stop and remove volumes (deletes all data)
docker-compose down -v
```

## Verifying pgvector

Once connected to the database:

```sql
-- Check if pgvector extension is available
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- Create the extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Test vector operations
CREATE TABLE test_vectors (id serial PRIMARY KEY, embedding vector(3));
INSERT INTO test_vectors (embedding) VALUES ('[1,2,3]'), ('[4,5,6]');
SELECT embedding <=> '[1,2,3]' AS distance FROM test_vectors ORDER BY distance;
```

## Troubleshooting

### Connection Refused
If you get connection errors, ensure PostgreSQL is running and healthy:
```bash
docker-compose ps
docker-compose logs postgres
```

### Port Already in Use
If port 5432 is already in use, modify `docker-compose.yml` to use a different port:
```yaml
ports:
  - "5433:5432"  # Use 5433 on host instead
```

Then update your environment variables:
```bash
export QMD_POSTGRES_PORT=5433
```

### Permission Denied
Ensure Docker has permission to bind to the ports and create volumes.
