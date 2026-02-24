import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { assertSchemaAllowed, formatResult } from '../utils/response.js';

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerIntrospectionTools(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[]
): void {
  server.registerTool(
    'postgres_list_schemas',
    {
      title: 'List PostgreSQL Schemas',
      description: 'Lista todos los esquemas accesibles en la base de datos PostgreSQL. Filtrado por DB_SCHEMAS si está configurado.',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS,
    },
    async () => {
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
    }
  );

  server.registerTool(
    'postgres_list_tables',
    {
      title: 'List Tables in Schema',
      description: 'Lista todas las tablas de un esquema específico con conteo de columnas y descripción. Soporta paginación con limit/offset.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema (ej: public)'),
        limit: z.number().int().min(1).max(500).default(50).describe('Máximo de tablas a retornar (default: 50)'),
        offset: z.number().int().min(0).default(0).describe('Número de tablas a omitir para paginación (default: 0)'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, limit, offset }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const countResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*) as total FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [schema]
      );
      const total = parseInt(countResult.rows[0].total);

      const result = await pool.query(
        `
        SELECT
          t.table_name,
          pg_catalog.obj_description(pgc.oid, 'pg_class') as table_description,
          (SELECT COUNT(*) FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) as column_count
        FROM information_schema.tables t
        LEFT JOIN pg_catalog.pg_class pgc ON pgc.relname = t.table_name
        LEFT JOIN pg_catalog.pg_namespace pgn
          ON pgn.oid = pgc.relnamespace AND pgn.nspname = t.table_schema
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
    }
  );

  server.registerTool(
    'postgres_describe_table',
    {
      title: 'Describe Table Structure',
      description: 'Describe la estructura completa de una tabla: columnas con tipos y defaults, constraints (PK/FK/UNIQUE) e índices.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        table: z.string().min(1).describe('Nombre de la tabla'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, table }) => {
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
          LEFT JOIN pg_catalog.pg_class pgc ON pgc.relname = c.table_name
          LEFT JOIN pg_catalog.pg_namespace pgn
            ON pgn.oid = pgc.relnamespace AND pgn.nspname = c.table_schema
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

      return formatResult({
        schema,
        table,
        columns: columnsResult.rows,
        constraints: constraintsResult.rows,
        indexes: indexesResult.rows,
      });
    }
  );
}
