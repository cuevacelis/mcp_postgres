import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { registerIntrospectionTools } from './tools/introspection.js';
import { registerObjectTools } from './tools/objects.js';
import { registerQueryTools } from './tools/query.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

const SERVER_INSTRUCTIONS = `Read-only PostgreSQL introspection and query server.

Use this server to:
- Discover database structure (schemas, tables, views, functions, triggers)
- Read table data with safe SELECT queries (single-table or multi-table with JOINs/CTEs)
- Inspect stored procedure source code and trigger definitions
- Profile query performance with EXPLAIN/EXPLAIN ANALYZE
- Search for columns across schemas when the user does not know where a field lives

Suggested workflow:
1. Start with postgres_list_schemas to see what is reachable.
2. Use postgres_list_tables or postgres_list_views to scope the work.
3. Use postgres_describe_table to learn columns/constraints/indexes before writing queries.
4. Prefer postgres_query_table for single-table reads (it is the safest path).
5. Escalate to postgres_execute_query only when JOINs, CTEs, or aggregations are needed.
6. Use postgres_explain_query before running expensive ad-hoc queries.

Hard guarantees: only SELECT/WITH statements run, every query is wrapped in READ ONLY transactions, results are capped at 100 rows, and access is restricted to the schemas allowed by the operator (DB_SCHEMAS env var).`;

export function createServer(pool: Pool, allowedSchemas: string[], defaultLimit: number): McpServer {
  const server = new McpServer(
    { name: 'mcp-postgres', version: '1.1.0' },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerIntrospectionTools(server, pool, allowedSchemas);
  registerObjectTools(server, pool, allowedSchemas);
  registerQueryTools(server, pool, allowedSchemas, defaultLimit);
  registerAnalysisTools(server, pool, allowedSchemas, defaultLimit);
  registerResources(server, pool, allowedSchemas);
  registerPrompts(server, allowedSchemas);

  return server;
}
