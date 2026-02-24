# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm run build      # Compile TypeScript → dist/
pnpm run dev        # Watch mode (auto-recompile on save)
pnpm start          # Run the compiled server (node dist/index.js)
npx tsx test-connection.ts  # Test PostgreSQL connectivity
```

Always run `pnpm run build` after editing any file in `src/` before testing changes.

## Architecture

This is a **Model Context Protocol (MCP) server** that exposes PostgreSQL database introspection and read-only querying capabilities to Claude Code via stdio transport.

**Module structure:**

```
src/
├── index.ts              # Bootstrap/entry point — connects transport, verifies DB
├── server.ts             # createServer() — instancia McpServer, llama register* de cada dominio
├── db/
│   └── pool.ts           # Pool, allowedSchemas, defaultLimit, isSchemaAllowed
├── tools/
│   ├── introspection.ts  # registerIntrospectionTools() — postgres_list_schemas/tables, postgres_describe_table
│   ├── objects.ts        # registerObjectTools() — postgres_list_functions/triggers, postgres_get_*_definition
│   └── query.ts          # registerQueryTools() — postgres_query_table, postgres_execute_query
└── utils/
    └── response.ts       # formatResult() (con CHARACTER_LIMIT=25000), assertSchemaAllowed()
```

**Import graph (no cycles):**
```
index.ts → db/pool.ts, server.ts
server.ts → tools/introspection.ts, tools/objects.ts, tools/query.ts
tools/* → utils/response.ts
test-connection.ts → db/pool.ts
```

**Runtime flow:** Claude Code spawns this process → communicates over stdio → server queries PostgreSQL → returns JSON results.

### MCP Tools

All tools carry `readOnlyHint: true`, `destructiveHint: false`. List tools support `limit`/`offset` pagination and return `has_more`/`next_offset`.

| Tool | Purpose |
|------|---------|
| `postgres_list_schemas` | All accessible schemas |
| `postgres_list_tables` | Tables in a schema — paginado, with column counts |
| `postgres_describe_table` | Full column/constraint/index details (3 queries en paralelo) |
| `postgres_list_functions` | Stored procedures with signatures — paginado |
| `postgres_list_triggers` | Triggers with event/timing — paginado |
| `postgres_query_table` | Simple single-table SELECT with WHERE/LIMIT |
| `postgres_execute_query` | Advanced queries (JOINs, CTEs, aggregations) |
| `postgres_get_function_definition` | Stored procedure source code |
| `postgres_get_trigger_definition` | Trigger definition |

### Security Model

- **Schema filtering:** `DB_SCHEMAS` env var (comma-separated) restricts access. Empty = all non-system schemas allowed.
- **Query validation:** Only `SELECT` and `WITH` (CTE) allowed. Blocked keywords checked via regex word boundaries: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE, EXECUTE, COPY.
- **Result limiting:** `DEFAULT_LIMIT` env var (default 5), capped at 100 rows max per query.
- **Timeouts:** 10s connection timeout, 30s statement timeout on `execute_query`.

## Environment Configuration

Copy `.env.example` to `.env` and configure:

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database_name
DB_USER=your_username
DB_PASSWORD=your_password
DB_SSL=false              # Set to true for AWS RDS / cloud databases
DB_SCHEMAS=public         # Comma-separated; empty = all schemas
DEFAULT_LIMIT=5
```

Multiple pre-configured `.env-*` files exist for different environments (e.g., `.env-ecosistema-prd`, `.env-db-admision-tst`). Copy the relevant one to `.env` to switch environments.

## Tech Stack

- **TypeScript** (ESM, `module: Node16`, `target: ES2022`, strict mode)
- **`@modelcontextprotocol/sdk` v1.24+** — `McpServer` + `registerTool` (API moderna)
- **`zod`** — Runtime validation de inputs en cada herramienta
- **`pg`** — PostgreSQL driver (Pool)
- **`dotenv`** — Environment variable loading
- **pnpm** — Package manager (use pnpm, not npm or yarn)
