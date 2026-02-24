# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm run build      # Compile TypeScript → dist/
pnpm run dev        # Watch mode (auto-recompile on save)
pnpm start          # Run the compiled server (node dist/index.js)
npx tsx test-connection.ts  # Test PostgreSQL connectivity
```

Always run `pnpm run build` after editing `src/index.ts` before testing changes.

## Architecture

This is a **Model Context Protocol (MCP) server** that exposes PostgreSQL database introspection and read-only querying capabilities to Claude Code via stdio transport.

**Single source file:** `src/index.ts` contains the entire server implementation (~700 lines):
- PostgreSQL pool initialization from `.env` variables
- 8 MCP tool definitions (JSON Schema)
- Tool handler implementations dispatched via `handleToolCall()`
- MCP `Server` setup with `StdioServerTransport`
- `main()` entry point that verifies DB connectivity before starting

**Runtime flow:** Claude Code spawns this process → communicates over stdio → server queries PostgreSQL → returns JSON results.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `list_schemas` | All accessible schemas |
| `list_tables` | Tables in a schema with column counts |
| `describe_table` | Full column/constraint/index details |
| `list_functions` | Stored procedures with signatures |
| `list_triggers` | Triggers with event/timing |
| `query_table` | Simple single-table SELECT with WHERE/LIMIT |
| `execute_query` | Advanced queries (JOINs, CTEs, aggregations) |
| `get_function_definition` | Stored procedure source code |
| `get_trigger_definition` | Trigger definition |

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
- **`@modelcontextprotocol/sdk`** — MCP Server and StdioServerTransport
- **`pg`** — PostgreSQL driver (Pool)
- **`dotenv`** — Environment variable loading
- **pnpm** — Package manager (use pnpm, not npm or yarn)
