import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { assertSchemaAllowed, formatResult } from '../utils/response.js';

const SQL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sqlIdentifierSchema = z
  .string()
  .regex(
    SQL_IDENTIFIER_REGEX,
    'Solo se permiten identificadores SQL simples (letras, números y guion bajo).'
  );

const scalarFilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const filterOperatorSchema = z.enum([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'ILIKE',
  'IN',
  'NOT IN',
  'IS NULL',
  'IS NOT NULL',
]);

const tableFilterSchema = z
  .object({
    column: sqlIdentifierSchema.describe('Nombre de columna para filtrar'),
    operator: filterOperatorSchema.default('=').describe('Operador de comparación'),
    value: z.union([scalarFilterValueSchema, z.array(scalarFilterValueSchema)]).optional(),
  })
  .superRefine((filter, ctx) => {
    if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
      if (filter.value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `El operador ${filter.operator} no acepta el campo 'value'.`,
          path: ['value'],
        });
      }
      return;
    }

    if (filter.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El operador ${filter.operator} requiere el campo 'value'.`,
        path: ['value'],
      });
      return;
    }

    if ((filter.operator === 'IN' || filter.operator === 'NOT IN') && !Array.isArray(filter.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El operador ${filter.operator} requiere un arreglo en 'value'.`,
        path: ['value'],
      });
      return;
    }

    if ((filter.operator === 'IN' || filter.operator === 'NOT IN') && Array.isArray(filter.value) && filter.value.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `El operador ${filter.operator} requiere al menos un valor.`,
        path: ['value'],
      });
    }
  });

const orderBySchema = z.object({
  column: sqlIdentifierSchema.describe('Nombre de columna para ordenar'),
  direction: z.enum(['ASC', 'DESC']).default('ASC').describe('Dirección del orden'),
});

type QueryParam = string | number | boolean | null;
type TableFilter = z.infer<typeof tableFilterSchema>;

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildFilterCondition(filter: TableFilter, params: QueryParam[]): string {
  const column = quoteIdentifier(filter.column);

  if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
    return `${column} ${filter.operator}`;
  }

  if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
    if (!Array.isArray(filter.value) || filter.value.length === 0) {
      throw new Error(`El operador ${filter.operator} requiere una lista de valores no vacía.`);
    }
    const placeholders = filter.value.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `${column} ${filter.operator} (${placeholders.join(', ')})`;
  }

  if (Array.isArray(filter.value)) {
    throw new Error(`El operador ${filter.operator} no acepta una lista en 'value'.`);
  }

  if (filter.value === null) {
    if (filter.operator === '=') {
      return `${column} IS NULL`;
    }
    if (filter.operator === '!=') {
      return `${column} IS NOT NULL`;
    }
    throw new Error(`El operador ${filter.operator} no es válido con value null.`);
  }

  if (filter.value === undefined) {
    throw new Error(`El operador ${filter.operator} requiere el campo 'value'.`);
  }

  params.push(filter.value);
  return `${column} ${filter.operator} $${params.length}`;
}

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
      description: `Ejecuta una consulta SELECT segura en una sola tabla con filtros estructurados y LIMIT automático. Para JOINs, subqueries, CTEs o consultas multi-tabla, usa postgres_execute_query. Límite máximo: 100 filas.`,
      inputSchema: {
        schema: sqlIdentifierSchema.describe('Nombre del esquema'),
        table: sqlIdentifierSchema.describe('Nombre de la tabla'),
        columns: z
          .array(sqlIdentifierSchema)
          .default([])
          .describe('Columnas a seleccionar. Vacío = todas las columnas (*)'),
        filters: z
          .array(tableFilterSchema)
          .max(20)
          .default([])
          .describe('Filtros estructurados combinados con AND'),
        order_by: z
          .array(orderBySchema)
          .max(5)
          .optional()
          .describe('Ordenamiento opcional'),
        limit: z.number().int().min(1).max(100).default(defaultLimit)
          .describe(`Número máximo de registros a retornar (default: ${defaultLimit}, max: 100)`),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, table, columns, filters, order_by, limit }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const safeLimit = Math.min(Math.max(1, limit), 100);
      const selectedColumns = columns.length > 0
        ? columns.map((column) => quoteIdentifier(column)).join(', ')
        : '*';
      let query = `SELECT ${selectedColumns} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

      const params: QueryParam[] = [];
      if (filters.length > 0) {
        const whereClauses = filters.map((filter) => buildFilterCondition(filter, params));
        query += ` WHERE ${whereClauses.join(' AND ')}`;
      }

      if (order_by && order_by.length > 0) {
        const orderByClause = order_by
          .map(({ column, direction }) => `${quoteIdentifier(column)} ${direction}`)
          .join(', ');
        query += ` ORDER BY ${orderByClause}`;
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
      const trimmedQuery = query.trim();
      const queryWithoutTrailingSemicolon = trimmedQuery.replace(/;\s*$/, '');
      const normalizedQuery = queryWithoutTrailingSemicolon.toLowerCase();

      if (queryWithoutTrailingSemicolon.includes(';')) {
        throw new Error('No se permiten múltiples sentencias SQL en postgres_execute_query.');
      }

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
      let finalQuery = queryWithoutTrailingSemicolon;

      const hasLimit = /\bLIMIT\s+\d+/i.test(finalQuery);
      if (!hasLimit) {
        finalQuery = `${finalQuery} LIMIT ${safeLimit}`;
      } else {
        const limitMatch = finalQuery.match(/\bLIMIT\s+(\d+)/i);
        if (limitMatch) {
          const effectiveLimit = Math.min(Number.parseInt(limitMatch[1], 10), 100);
          finalQuery = finalQuery.replace(/\bLIMIT\s+\d+/i, `LIMIT ${effectiveLimit}`);
        }
      }

      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query('BEGIN');
        transactionStarted = true;
        await client.query('SET TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 30000');
        if (allowedSchemas.length > 0) {
          const searchPath = allowedSchemas.map((schemaName) => quoteIdentifier(schemaName)).join(', ');
          await client.query(`SET LOCAL search_path = ${searchPath}`);
        }
        const result = await client.query(finalQuery);
        await client.query('COMMIT');
        transactionStarted = false;

        return formatResult({
          query: finalQuery,
          rows: result.rows,
          row_count: result.rows.length,
          fields: result.fields.map((f) => f.name),
        });
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Ignorado: si falla rollback, se prioriza propagar el error original.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    }
  );
}
