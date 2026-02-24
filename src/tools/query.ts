import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { assertSchemaAllowed, formatResult } from '../utils/response.js';

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerQueryTools(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[],
  defaultLimit: number
): void {
  server.registerTool(
    'postgres_query_table',
    {
      title: 'Query Single Table',
      description: `Ejecuta una consulta SELECT simple en una sola tabla con LIMIT automático. Para JOINs, subqueries, CTEs o consultas multi-tabla, usa postgres_execute_query. Límite máximo: 100 filas.`,
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        table: z.string().min(1).describe('Nombre de la tabla'),
        columns: z.string().default('*').describe('Columnas a seleccionar (ej: "id, name" o "*" para todas)'),
        where: z.string().optional().describe('Cláusula WHERE opcional (sin la palabra WHERE)'),
        limit: z.number().int().min(1).max(100).default(defaultLimit)
          .describe(`Número máximo de registros a retornar (default: ${defaultLimit}, max: 100)`),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, table, columns, where, limit }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const safeLimit = Math.min(Math.max(1, limit), 100);
      let query = `SELECT ${columns} FROM "${schema}"."${table}"`;

      const params: unknown[] = [];
      if (where) {
        query += ` WHERE ${where}`;
      }
      query += ` LIMIT $${params.length + 1}`;
      params.push(safeLimit);

      const result = await pool.query(query, params);

      return formatResult({
        schema,
        table,
        query,
        rows: result.rows,
        row_count: result.rows.length,
        limit: safeLimit,
      });
    }
  );

  server.registerTool(
    'postgres_execute_query',
    {
      title: 'Execute Read-Only SQL Query',
      description: `Ejecuta una consulta SQL SELECT completa de solo lectura. Soporta JOINs, subqueries, CTEs (WITH), funciones de agregación, UNION y operaciones multi-tabla. Solo se permiten SELECT/WITH. Timeout: 30 segundos. Máximo: 100 filas.`,
      inputSchema: {
        query: z.string().min(1).describe('Consulta SQL SELECT completa (ej: SELECT a.*, b.name FROM schema1.t1 a JOIN schema1.t2 b ON a.id = b.id)'),
        limit: z.number().int().min(1).max(100).default(defaultLimit)
          .describe(`Límite máximo de filas (default: ${defaultLimit}, max: 100)`),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, limit }) => {
      const normalizedQuery = query.trim().toLowerCase();

      if (!normalizedQuery.startsWith('select') && !normalizedQuery.startsWith('with')) {
        throw new Error('Solo se permiten consultas SELECT o WITH (CTE). No se permiten INSERT, UPDATE, DELETE, DROP, ALTER, CREATE u otras operaciones de modificación.');
      }

      const forbiddenKeywords = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'execute', 'copy'];
      for (const keyword of forbiddenKeywords) {
        const regex = new RegExp(`\\b${keyword}\\b\\s+(into|from|table|schema|database|index|function|procedure|trigger|role|user|privileges|on|all)\\b`, 'i');
        if (regex.test(query)) {
          throw new Error(`Operación no permitida: la query contiene '${keyword}' seguido de un contexto de modificación. Solo se permiten consultas de lectura (SELECT/WITH).`);
        }
      }

      const safeLimit = Math.min(Math.max(1, limit), 100);
      let finalQuery = query.trim();

      const hasLimit = /\bLIMIT\s+\d+/i.test(finalQuery);
      if (!hasLimit) {
        finalQuery = `${finalQuery} LIMIT ${safeLimit}`;
      } else {
        const limitMatch = finalQuery.match(/\bLIMIT\s+(\d+)/i);
        if (limitMatch) {
          const effectiveLimit = Math.min(parseInt(limitMatch[1]), 100);
          finalQuery = finalQuery.replace(/\bLIMIT\s+\d+/i, `LIMIT ${effectiveLimit}`);
        }
      }

      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 30000');
        if (allowedSchemas.length > 0) {
          const searchPath = allowedSchemas.map((s) => `"${s}"`).join(', ');
          await client.query(`SET search_path = ${searchPath}`);
        }
        const result = await client.query(finalQuery);

        return formatResult({
          query: finalQuery,
          rows: result.rows,
          row_count: result.rows.length,
          fields: result.fields.map((f) => f.name),
        });
      } finally {
        client.release();
      }
    }
  );
}
