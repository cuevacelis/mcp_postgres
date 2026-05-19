import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import {
  assertSchemaAllowed,
  formatResult,
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

const paginationFields = {
  limit: z.number().int().min(1).max(500).default(50).describe('Maximum rows to return (default: 50, max: 500).'),
  offset: z.number().int().min(0).default(0).describe('Rows to skip for pagination (default: 0).'),
};

const listSchemasOutput = {
  schemas: z.array(z.string()),
  total: z.number().int(),
  configured_schemas: z.union([z.array(z.string()), z.literal('all')]),
};

const tableRowSchema = z.object({
  table_name: z.string(),
  table_description: z.string().nullable(),
  column_count: z.union([z.string(), z.number()]),
});

const listTablesOutput = {
  schema: z.string(),
  tables: z.array(tableRowSchema),
  count: z.number().int(),
  total: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
};

const columnSchema = z.object({
  column_name: z.string(),
  data_type: z.string(),
  character_maximum_length: z.number().nullable(),
  is_nullable: z.string(),
  column_default: z.string().nullable(),
  column_description: z.string().nullable(),
});

const constraintSchema = z.object({
  constraint_name: z.string(),
  constraint_type: z.string(),
  column_name: z.string().nullable(),
  foreign_table_schema: z.string().nullable(),
  foreign_table_name: z.string().nullable(),
  foreign_column_name: z.string().nullable(),
});

const indexSchema = z.object({
  index_name: z.string(),
  column_name: z.string(),
  is_unique: z.boolean(),
  is_primary: z.boolean(),
});

const describeTableOutput = {
  schema: z.string(),
  table: z.string(),
  columns: z.array(columnSchema),
  constraints: z.array(constraintSchema),
  indexes: z.array(indexSchema),
};

export function registerIntrospectionTools(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[]
): void {
  server.registerTool(
    'postgres_list_schemas',
    {
      title: 'List PostgreSQL Schemas',
      description: 'Lists every accessible schema in the database. System schemas are excluded. When DB_SCHEMAS is set, only those schemas are returned.',
      inputSchema: {},
      outputSchema: listSchemasOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await pool.query(`
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY schema_name
        `);

        const schemas = result.rows.map((row) => row.schema_name as string);
        const filtered = allowedSchemas.length > 0
          ? schemas.filter((s) => allowedSchemas.includes(s))
          : schemas;

        return formatResult({
          schemas: filtered,
          total: filtered.length,
          configured_schemas: allowedSchemas.length > 0 ? allowedSchemas : 'all',
        });
      } catch (error) {
        return toolError('Failed to list schemas', unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_list_tables',
    {
      title: 'List Tables in Schema',
      description: 'Lists base tables in a schema, with column counts and table-level comments. Supports limit/offset pagination; returns has_more and next_offset when more rows exist.',
      inputSchema: {
        schema: sqlIdentifier.describe('Schema name (e.g., public).'),
        ...paginationFields,
      },
      outputSchema: listTablesOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, limit, offset }) => {
      try {
        assertSchemaAllowed(schema, allowedSchemas);

        const countResult = await pool.query<{ total: string }>(
          `SELECT COUNT(*) as total FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
          [schema]
        );
        const total = Number.parseInt(countResult.rows[0].total, 10);

        const result = await pool.query(
          `
          SELECT
            t.table_name,
            pg_catalog.obj_description(pgc.oid, 'pg_class') as table_description,
            (SELECT COUNT(*) FROM information_schema.columns c
             WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) as column_count
          FROM information_schema.tables t
          LEFT JOIN pg_catalog.pg_namespace pgn ON pgn.nspname = t.table_schema
          LEFT JOIN pg_catalog.pg_class pgc
            ON pgc.relname = t.table_name
            AND pgc.relnamespace = pgn.oid
          WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
          ORDER BY t.table_name
          LIMIT $2 OFFSET $3
          `,
          [schema, limit, offset]
        );

        const count = result.rows.length;
        return formatResult({
          schema,
          tables: result.rows,
          count,
          total,
          offset,
          has_more: total > offset + count,
          ...(total > offset + count ? { next_offset: offset + count } : {}),
        });
      } catch (error) {
        return toolError(`Failed to list tables in '${schema}'`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_describe_table',
    {
      title: 'Describe Table Structure',
      description: 'Returns full column metadata (types, defaults, nullability, comments), constraints (PK/FK/UNIQUE/CHECK), and indexes for a table. Three pg_catalog queries run in parallel.',
      inputSchema: {
        schema: sqlIdentifier.describe('Schema name.'),
        table: sqlIdentifier.describe('Table name.'),
      },
      outputSchema: describeTableOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, table }) => {
      try {
        assertSchemaAllowed(schema, allowedSchemas);

        const [columnsResult, constraintsResult, indexesResult] = await Promise.all([
          pool.query(
            `
            SELECT
              c.column_name,
              c.data_type,
              c.character_maximum_length,
              c.is_nullable,
              c.column_default,
              pg_catalog.col_description(pgc.oid, c.ordinal_position) as column_description
            FROM information_schema.columns c
            LEFT JOIN pg_catalog.pg_namespace pgn ON pgn.nspname = c.table_schema
            LEFT JOIN pg_catalog.pg_class pgc
              ON pgc.relname = c.table_name
              AND pgc.relnamespace = pgn.oid
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
            `,
            [schema, table]
          ),
          pool.query(
            `
            SELECT
              tc.constraint_name,
              tc.constraint_type,
              kcu.column_name,
              ccu.table_schema AS foreign_table_schema,
              ccu.table_name AS foreign_table_name,
              ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints AS tc
            LEFT JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            LEFT JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            WHERE tc.table_schema = $1 AND tc.table_name = $2
            ORDER BY tc.constraint_type, tc.constraint_name
            `,
            [schema, table]
          ),
          pool.query(
            `
            SELECT
              i.relname as index_name,
              a.attname as column_name,
              ix.indisunique as is_unique,
              ix.indisprimary as is_primary
            FROM pg_class t
            JOIN pg_index ix ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = $1 AND t.relname = $2
            ORDER BY i.relname, a.attnum
            `,
            [schema, table]
          ),
        ]);

        if (columnsResult.rows.length === 0) {
          return toolError(`Table '${schema}.${table}' not found or has no columns visible to this role.`);
        }

        return formatResult({
          schema,
          table,
          columns: columnsResult.rows,
          constraints: constraintsResult.rows,
          indexes: indexesResult.rows,
        });
      } catch (error) {
        return toolError(`Failed to describe '${schema}.${table}'`, unwrapError(error));
      }
    }
  );
}
