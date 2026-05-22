import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import {
  buildSchemaDescription,
  formatResult,
  resolveSchema,
  toolError,
  unwrapError,
} from '../utils/response.js';

const SQL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sqlIdentifierSchema = z
  .string()
  .regex(SQL_IDENTIFIER_REGEX, 'Only simple SQL identifiers are allowed (letters, digits, underscore).');

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
    column: sqlIdentifierSchema.describe('Column to filter on.'),
    operator: filterOperatorSchema.default('=').describe('Comparison operator.'),
    value: z.union([scalarFilterValueSchema, z.array(scalarFilterValueSchema)]).optional(),
  })
  .superRefine((filter, ctx) => {
    if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
      if (filter.value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Operator ${filter.operator} does not accept a 'value' field.`,
          path: ['value'],
        });
      }
      return;
    }

    if (filter.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator ${filter.operator} requires a 'value' field.`,
        path: ['value'],
      });
      return;
    }

    if ((filter.operator === 'IN' || filter.operator === 'NOT IN') && !Array.isArray(filter.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator ${filter.operator} requires an array in 'value'.`,
        path: ['value'],
      });
      return;
    }

    if ((filter.operator === 'IN' || filter.operator === 'NOT IN') && Array.isArray(filter.value) && filter.value.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator ${filter.operator} requires at least one value.`,
        path: ['value'],
      });
    }
  });

const orderBySchema = z.object({
  column: sqlIdentifierSchema.describe('Column to order by.'),
  direction: z.enum(['ASC', 'DESC']).default('ASC').describe('Sort direction.'),
});

type QueryParam = string | number | boolean | null;
type TableFilter = z.infer<typeof tableFilterSchema>;

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const queryTableOutput = {
  schema: z.string(),
  table: z.string(),
  query: z.string(),
  rows: z.array(z.record(z.unknown())),
  row_count: z.number().int(),
  limit: z.number().int(),
};

const executeQueryOutput = {
  query: z.string(),
  rows: z.array(z.record(z.unknown())),
  row_count: z.number().int(),
  fields: z.array(z.string()),
};

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
      throw new Error(`Operator ${filter.operator} requires a non-empty array of values.`);
    }
    const placeholders = filter.value.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `${column} ${filter.operator} (${placeholders.join(', ')})`;
  }

  if (Array.isArray(filter.value)) {
    throw new Error(`Operator ${filter.operator} does not accept an array in 'value'.`);
  }

  if (filter.value === null) {
    if (filter.operator === '=') {
      return `${column} IS NULL`;
    }
    if (filter.operator === '!=') {
      return `${column} IS NOT NULL`;
    }
    throw new Error(`Operator ${filter.operator} is not valid with null value.`);
  }

  if (filter.value === undefined) {
    throw new Error(`Operator ${filter.operator} requires a 'value' field.`);
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
      description: 'Runs a safe SELECT on a single table using structured filters (parameterized) and an automatic LIMIT. Use this as the default read tool. For JOINs, subqueries, CTEs, or aggregations escalate to postgres_execute_query. Max 100 rows.',
      inputSchema: {
        schema: sqlIdentifierSchema.optional().describe(buildSchemaDescription(allowedSchemas)),
        table: sqlIdentifierSchema.describe('Table name.'),
        columns: z
          .array(sqlIdentifierSchema)
          .default([])
          .describe('Columns to project. Empty = all columns (*).'),
        filters: z
          .array(tableFilterSchema)
          .max(20)
          .default([])
          .describe('Structured filters combined with AND. Values are always parameterized.'),
        order_by: z
          .array(orderBySchema)
          .max(5)
          .optional()
          .describe('Optional ORDER BY clauses.'),
        limit: z.number().int().min(1).max(100).default(defaultLimit)
          .describe(`Maximum rows to return (default: ${defaultLimit}, max: 100).`),
      },
      outputSchema: queryTableOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, table, columns, filters, order_by, limit }) => {
      let resolvedSchema: string | undefined;
      try {
        resolvedSchema = resolveSchema(schema, allowedSchemas);

        const safeLimit = Math.min(Math.max(1, limit), 100);
        const selectedColumns = columns.length > 0
          ? columns.map((column) => quoteIdentifier(column)).join(', ')
          : '*';
        let query = `SELECT ${selectedColumns} FROM ${quoteIdentifier(resolvedSchema)}.${quoteIdentifier(table)}`;

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
          schema: resolvedSchema,
          table,
          query,
          rows: result.rows,
          row_count: result.rows.length,
          limit: safeLimit,
        });
      } catch (error) {
        return toolError(`Query on '${resolvedSchema ?? '?'}.${table}' failed`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_execute_query',
    {
      title: 'Execute Read-Only SQL Query',
      description: 'Runs an ad-hoc SELECT / WITH (CTE) query. Supports JOINs, subqueries, aggregations and UNION. Single statement only. Runs in a READ ONLY transaction with a 30s statement_timeout. Max 100 rows (auto-injected or clamped).',
      inputSchema: {
        query: z.string().min(1).describe('Full SELECT or WITH (CTE) SQL. One statement, no trailing INSERT/UPDATE/DELETE.'),
        limit: z.number().int().min(1).max(100).default(defaultLimit)
          .describe(`Maximum rows to return (default: ${defaultLimit}, max: 100).`),
      },
      outputSchema: executeQueryOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, limit }) => {
      const trimmedQuery = query.trim();
      const queryWithoutTrailingSemicolon = trimmedQuery.replace(/;\s*$/, '');
      const normalizedQuery = queryWithoutTrailingSemicolon.toLowerCase();

      if (queryWithoutTrailingSemicolon.includes(';')) {
        return toolError('Multiple SQL statements are not allowed in postgres_execute_query.');
      }

      if (!normalizedQuery.startsWith('select') && !normalizedQuery.startsWith('with')) {
        return toolError(
          'Only SELECT or WITH (CTE) queries are allowed. INSERT, UPDATE, DELETE, DROP, ALTER, CREATE and other write operations are forbidden.'
        );
      }

      const forbiddenKeywords = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'execute', 'copy'];
      for (const keyword of forbiddenKeywords) {
        const regex = new RegExp(`\\b${keyword}\\b\\s+(into|from|table|schema|database|index|function|procedure|trigger|role|user|privileges|on|all)\\b`, 'i');
        if (regex.test(query)) {
          return toolError(
            `Operation not allowed: query contains '${keyword}' followed by a write-context keyword. Only read queries (SELECT/WITH) are accepted.`
          );
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
            // Rollback failure is intentionally swallowed so the original error propagates.
          }
        }
        return toolError('Query execution failed', { ...unwrapError(error), query: finalQuery });
      } finally {
        client.release();
      }
    }
  );
}
