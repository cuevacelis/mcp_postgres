import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import {
  assertSchemaAllowed,
  buildSchemaDescription,
  formatResult,
  resolveSchema,
  toolError,
  unwrapError,
} from '../utils/response.js';

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const sqlIdentifier = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Only simple SQL identifiers are allowed (letters, digits, underscore).');

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

const explainOutput = {
  query: z.string(),
  format: z.string(),
  plan: z.unknown(),
};

const viewRowSchema = z.object({
  view_name: z.string(),
  view_type: z.enum(['view', 'materialized_view']),
  description: z.string().nullable(),
  is_updatable: z.string().nullable(),
});

const listViewsOutput = {
  schema: z.string(),
  views: z.array(viewRowSchema),
  count: z.number().int(),
  total: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
};

const columnHitSchema = z.object({
  schema: z.string(),
  table: z.string(),
  table_type: z.string(),
  column_name: z.string(),
  data_type: z.string(),
  is_nullable: z.string(),
  column_description: z.string().nullable(),
});

const searchColumnsOutput = {
  pattern: z.string(),
  match_mode: z.enum(['contains', 'exact', 'prefix', 'suffix']),
  hits: z.array(columnHitSchema),
  count: z.number().int(),
  truncated: z.boolean(),
};

const tableStatsOutput = {
  schema: z.string(),
  table: z.string(),
  estimated_row_count: z.number(),
  total_size_bytes: z.number(),
  total_size_pretty: z.string(),
  table_size_bytes: z.number(),
  indexes_size_bytes: z.number(),
  toast_size_bytes: z.number(),
  index_count: z.number().int(),
  last_vacuum: z.string().nullable(),
  last_autovacuum: z.string().nullable(),
  last_analyze: z.string().nullable(),
  last_autoanalyze: z.string().nullable(),
  n_live_tup: z.number().nullable(),
  n_dead_tup: z.number().nullable(),
  indexes: z.array(z.object({
    index_name: z.string(),
    size_bytes: z.number(),
    size_pretty: z.string(),
    scans: z.number().nullable(),
  })),
};

export function registerAnalysisTools(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[],
  defaultLimit: number
): void {
  server.registerTool(
    'postgres_explain_query',
    {
      title: 'Explain Query Plan',
      description: 'Runs EXPLAIN (and optionally EXPLAIN ANALYZE) against a SELECT / WITH query to inspect the planner output. ANALYZE actually executes the query under a READ ONLY transaction with a 30s statement_timeout. Use this before running expensive ad-hoc queries.',
      inputSchema: {
        query: z.string().min(1).describe('SELECT or WITH (CTE) statement to profile. Single statement only.'),
        analyze: z.boolean().default(false).describe('When true runs EXPLAIN ANALYZE (executes the query). Default: false.'),
        format: z.enum(['json', 'text']).default('json').describe('Plan output format. Default: json.'),
      },
      outputSchema: explainOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, analyze, format }) => {
      const trimmed = query.trim().replace(/;\s*$/, '');
      const normalized = trimmed.toLowerCase();

      if (trimmed.includes(';')) {
        return toolError('Multiple SQL statements are not allowed in postgres_explain_query.');
      }
      if (!normalized.startsWith('select') && !normalized.startsWith('with')) {
        return toolError('Only SELECT or WITH (CTE) statements can be explained.');
      }

      const options = [analyze ? 'ANALYZE' : '', 'VERBOSE FALSE', `FORMAT ${format.toUpperCase()}`]
        .filter(Boolean)
        .join(', ');
      const explainSql = `EXPLAIN (${options}) ${trimmed}`;

      const client = await pool.connect();
      let txStarted = false;
      try {
        await client.query('BEGIN');
        txStarted = true;
        await client.query('SET TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 30000');
        if (allowedSchemas.length > 0) {
          const searchPath = allowedSchemas.map(quoteIdentifier).join(', ');
          await client.query(`SET LOCAL search_path = ${searchPath}`);
        }

        const result = await client.query(explainSql);
        await client.query('COMMIT');
        txStarted = false;

        const plan = format === 'json'
          ? result.rows[0]?.['QUERY PLAN']
          : result.rows.map((row) => row['QUERY PLAN']).join('\n');

        return formatResult({
          query: trimmed,
          format,
          plan,
        });
      } catch (error) {
        if (txStarted) {
          try { await client.query('ROLLBACK'); } catch { /* swallowed */ }
        }
        return toolError('EXPLAIN failed', { ...unwrapError(error), explain_sql: explainSql });
      } finally {
        client.release();
      }
    }
  );

  server.registerTool(
    'postgres_list_views',
    {
      title: 'List Views and Materialized Views',
      description: 'Lists regular views and materialized views in a schema, with their comments and updatability flag (for regular views). Paginated.',
      inputSchema: {
        schema: sqlIdentifier.optional().describe(buildSchemaDescription(allowedSchemas)),
        include_materialized: z.boolean().default(true).describe('Include materialized views in the result.'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: listViewsOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, include_materialized, limit, offset }) => {
      let resolvedSchema: string | undefined;
      try {
        resolvedSchema = resolveSchema(schema, allowedSchemas);

        const typeFilter = include_materialized
          ? `c.relkind IN ('v', 'm')`
          : `c.relkind = 'v'`;

        const countResult = await pool.query<{ total: string }>(
          `SELECT COUNT(*) as total
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND ${typeFilter}`,
          [resolvedSchema]
        );
        const total = Number.parseInt(countResult.rows[0].total, 10);

        const result = await pool.query(
          `
          SELECT
            c.relname as view_name,
            CASE WHEN c.relkind = 'm' THEN 'materialized_view' ELSE 'view' END as view_type,
            pg_catalog.obj_description(c.oid, 'pg_class') as description,
            iv.is_updatable
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN information_schema.views iv
            ON iv.table_schema = n.nspname AND iv.table_name = c.relname
          WHERE n.nspname = $1 AND ${typeFilter}
          ORDER BY c.relname
          LIMIT $2 OFFSET $3
          `,
          [resolvedSchema, limit, offset]
        );

        const count = result.rows.length;
        return formatResult({
          schema: resolvedSchema,
          views: result.rows,
          count,
          total,
          offset,
          has_more: total > offset + count,
          ...(total > offset + count ? { next_offset: offset + count } : {}),
        });
      } catch (error) {
        return toolError(`Failed to list views${resolvedSchema ? ` in '${resolvedSchema}'` : ''}`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_search_columns',
    {
      title: 'Search Columns Across Schemas',
      description: 'Searches columns by name across all allowed schemas. Useful when you do not know which table holds a given field (e.g. "user_id", "email", "created_at"). Returns up to `limit` hits ordered by schema and table.',
      inputSchema: {
        pattern: z.string().min(1).describe('Search pattern (case-insensitive).'),
        match_mode: z.enum(['contains', 'exact', 'prefix', 'suffix']).default('contains').describe('How the pattern matches the column name.'),
        schemas: z.array(sqlIdentifier).optional().describe('Restrict search to these schemas. Defaults to all allowed schemas.'),
        include_views: z.boolean().default(true).describe('Include columns of views and materialized views.'),
        limit: z.number().int().min(1).max(500).default(Math.max(defaultLimit, 50)).describe('Maximum hits to return (default 50, max 500).'),
      },
      outputSchema: searchColumnsOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ pattern, match_mode, schemas, include_views, limit }) => {
      try {
        const targetSchemas = (schemas && schemas.length > 0 ? schemas : allowedSchemas);
        for (const s of targetSchemas) {
          assertSchemaAllowed(s, allowedSchemas);
        }

        const likePattern =
          match_mode === 'exact' ? pattern
            : match_mode === 'prefix' ? `${pattern}%`
              : match_mode === 'suffix' ? `%${pattern}`
                : `%${pattern}%`;

        const typeFilter = include_views
          ? `c.table_type IN ('BASE TABLE', 'VIEW')`
          : `c.table_type = 'BASE TABLE'`;

        const params: (string | number)[] = [likePattern];
        let schemaFilter = '';
        if (targetSchemas.length > 0) {
          params.push(...targetSchemas);
          const placeholders = targetSchemas.map((_, i) => `$${i + 2}`).join(', ');
          schemaFilter = `AND c.table_schema IN (${placeholders})`;
        } else {
          schemaFilter = `AND c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
        }

        const limitParamIndex = params.length + 1;
        params.push(limit + 1); // fetch one extra to detect truncation

        const result = await pool.query(
          `
          SELECT
            c.table_schema  AS schema,
            c.table_name    AS "table",
            c.table_type    AS table_type,
            c.column_name,
            c.data_type,
            c.is_nullable,
            pg_catalog.col_description(pgc.oid, c.ordinal_position) AS column_description
          FROM information_schema.columns c
          LEFT JOIN pg_catalog.pg_namespace pgn ON pgn.nspname = c.table_schema
          LEFT JOIN pg_catalog.pg_class pgc
            ON pgc.relname = c.table_name AND pgc.relnamespace = pgn.oid
          WHERE c.column_name ILIKE $1
            AND ${typeFilter}
            ${schemaFilter}
          ORDER BY c.table_schema, c.table_name, c.ordinal_position
          LIMIT $${limitParamIndex}
          `,
          params
        );

        const hits = result.rows.slice(0, limit);
        const truncated = result.rows.length > limit;

        return formatResult({
          pattern,
          match_mode,
          hits,
          count: hits.length,
          truncated,
        });
      } catch (error) {
        return toolError(`Column search for '${pattern}' failed`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_get_table_stats',
    {
      title: 'Get Table Storage and Activity Stats',
      description: 'Returns storage footprint (total/table/indexes/toast), estimated and live/dead row counts, vacuum/analyze timestamps, and per-index size and scan counts for a table. Useful for spotting bloat, unused indexes, or stale statistics.',
      inputSchema: {
        schema: sqlIdentifier.optional().describe(buildSchemaDescription(allowedSchemas)),
        table: sqlIdentifier.describe('Table name.'),
      },
      outputSchema: tableStatsOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, table }) => {
      let resolvedSchema: string | undefined;
      try {
        resolvedSchema = resolveSchema(schema, allowedSchemas);

        const sizesResult = await pool.query(
          `
          SELECT
            c.oid,
            pg_catalog.pg_total_relation_size(c.oid)        AS total_size_bytes,
            pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS total_size_pretty,
            pg_catalog.pg_relation_size(c.oid)              AS table_size_bytes,
            pg_catalog.pg_indexes_size(c.oid)               AS indexes_size_bytes,
            COALESCE(pg_catalog.pg_total_relation_size(c.reltoastrelid), 0) AS toast_size_bytes,
            c.reltuples                                     AS estimated_row_count
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'm')
          `,
          [resolvedSchema, table]
        );

        if (sizesResult.rows.length === 0) {
          return toolError(`Table '${resolvedSchema}.${table}' not found.`);
        }
        const sizeRow = sizesResult.rows[0];

        const statsResult = await pool.query(
          `
          SELECT
            n_live_tup,
            n_dead_tup,
            last_vacuum,
            last_autovacuum,
            last_analyze,
            last_autoanalyze
          FROM pg_catalog.pg_stat_user_tables
          WHERE schemaname = $1 AND relname = $2
          `,
          [resolvedSchema, table]
        );
        const stats = statsResult.rows[0] ?? {};

        const indexesResult = await pool.query(
          `
          SELECT
            i.relname AS index_name,
            pg_catalog.pg_relation_size(i.oid) AS size_bytes,
            pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(i.oid)) AS size_pretty,
            s.idx_scan AS scans
          FROM pg_catalog.pg_index ix
          JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
          LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid = i.oid
          WHERE ix.indrelid = $1
          ORDER BY size_bytes DESC
          `,
          [sizeRow.oid]
        );

        return formatResult({
          schema: resolvedSchema,
          table,
          estimated_row_count: Number(sizeRow.estimated_row_count),
          total_size_bytes: Number(sizeRow.total_size_bytes),
          total_size_pretty: sizeRow.total_size_pretty,
          table_size_bytes: Number(sizeRow.table_size_bytes),
          indexes_size_bytes: Number(sizeRow.indexes_size_bytes),
          toast_size_bytes: Number(sizeRow.toast_size_bytes),
          index_count: indexesResult.rows.length,
          last_vacuum: stats.last_vacuum ? new Date(stats.last_vacuum).toISOString() : null,
          last_autovacuum: stats.last_autovacuum ? new Date(stats.last_autovacuum).toISOString() : null,
          last_analyze: stats.last_analyze ? new Date(stats.last_analyze).toISOString() : null,
          last_autoanalyze: stats.last_autoanalyze ? new Date(stats.last_autoanalyze).toISOString() : null,
          n_live_tup: stats.n_live_tup !== undefined ? Number(stats.n_live_tup) : null,
          n_dead_tup: stats.n_dead_tup !== undefined ? Number(stats.n_dead_tup) : null,
          indexes: indexesResult.rows.map((r) => ({
            index_name: r.index_name,
            size_bytes: Number(r.size_bytes),
            size_pretty: r.size_pretty,
            scans: r.scans !== null ? Number(r.scans) : null,
          })),
        });
      } catch (error) {
        return toolError(`Failed to fetch stats for '${resolvedSchema ?? '?'}.${table}'`, unwrapError(error));
      }
    }
  );
}
