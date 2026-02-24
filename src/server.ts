import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { registerIntrospectionTools } from './tools/introspection.js';
import { registerObjectTools } from './tools/objects.js';
import { registerQueryTools } from './tools/query.js';

export function createServer(pool: Pool, allowedSchemas: string[], defaultLimit: number): McpServer {
  const server = new McpServer({ name: 'mcp-postgres', version: '1.0.0' });

  registerIntrospectionTools(server, pool, allowedSchemas);
  registerObjectTools(server, pool, allowedSchemas);
  registerQueryTools(server, pool, allowedSchemas, defaultLimit);

  return server;
}
