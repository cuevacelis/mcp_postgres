import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';

const SQL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSchemaReachable(schema: string, allowedSchemas: string[]): boolean {
  return allowedSchemas.length === 0 || allowedSchemas.includes(schema);
}

export function registerResources(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[]
): void {
  server.registerResource(
    'schema',
    new ResourceTemplate('postgres://schema/{schema}', {
      list: async () => {
        const result = await pool.query(`
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY schema_name
        `);
        const schemas = result.rows
          .map((row) => row.schema_name as string)
          .filter((s) => isSchemaReachable(s, allowedSchemas));
        return {
          resources: schemas.map((s) => ({
            uri: `postgres://schema/${s}`,
            name: s,
            description: `PostgreSQL schema '${s}' — tables, views, functions and triggers.`,
            mimeType: 'application/json',
          })),
        };
      },
      complete: {
        schema: async (partial) => {
          const result = await pool.query(`
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name
          `);
          return result.rows
            .map((row) => row.schema_name as string)
            .filter((s) => isSchemaReachable(s, allowedSchemas))
            .filter((s) => s.toLowerCase().startsWith(partial.toLowerCase()));
        },
      },
    }),
    {
      title: 'PostgreSQL Schema',
      description: 'Summary of a schema: list of tables (with column counts), views, functions and triggers.',
      mimeType: 'application/json',
    },
    async (uri, { schema }) => {
      const schemaName = String(schema);
      if (!SQL_IDENTIFIER_REGEX.test(schemaName)) {
        throw new Error(`Invalid schema identifier: '${schemaName}'`);
      }
      if (!isSchemaReachable(schemaName, allowedSchemas)) {
        throw new Error(`Schema '${schemaName}' is not in the allowed schemas list`);
      }

      const [tables, views, functions, triggers] = await Promise.all([
        pool.query(
          `SELECT table_name,
                  (SELECT COUNT(*) FROM information_schema.columns c
                   WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
           FROM information_schema.tables t
           WHERE table_schema = $1 AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
          [schemaName]
        ),
        pool.query(
          `SELECT c.relname AS view_name,
                  CASE WHEN c.relkind = 'm' THEN 'materialized_view' ELSE 'view' END AS view_type
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
           ORDER BY c.relname`,
          [schemaName]
        ),
        pool.query(
          `SELECT p.proname AS function_name,
                  pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
                  pg_catalog.pg_get_function_result(p.oid)    AS return_type
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1
           ORDER BY p.proname`,
          [schemaName]
        ),
        pool.query(
          `SELECT tg.tgname AS trigger_name, c.relname AS table_name
           FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND NOT tg.tgisinternal
           ORDER BY c.relname, tg.tgname`,
          [schemaName]
        ),
      ]);

      const payload = {
        schema: schemaName,
        tables: tables.rows,
        views: views.rows,
        functions: functions.rows,
        triggers: triggers.rows,
        counts: {
          tables: tables.rows.length,
          views: views.rows.length,
          functions: functions.rows.length,
          triggers: triggers.rows.length,
        },
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        }],
      };
    }
  );

  server.registerResource(
    'table',
    new ResourceTemplate('postgres://table/{schema}/{table}', {
      list: async () => {
        if (allowedSchemas.length === 0) {
          return { resources: [] };
        }
        const result = await pool.query(
          `SELECT table_schema, table_name
           FROM information_schema.tables
           WHERE table_schema = ANY($1)
             AND table_type = 'BASE TABLE'
           ORDER BY table_schema, table_name
           LIMIT 500`,
          [allowedSchemas]
        );
        return {
          resources: result.rows.map((row) => ({
            uri: `postgres://table/${row.table_schema}/${row.table_name}`,
            name: `${row.table_schema}.${row.table_name}`,
            description: `Structure of ${row.table_schema}.${row.table_name}.`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'PostgreSQL Table Structure',
      description: 'Columns (with types and defaults), constraints and indexes for a specific table.',
      mimeType: 'application/json',
    },
    async (uri, { schema, table }) => {
      const schemaName = String(schema);
      const tableName = String(table);
      if (!SQL_IDENTIFIER_REGEX.test(schemaName) || !SQL_IDENTIFIER_REGEX.test(tableName)) {
        throw new Error(`Invalid identifier in URI: ${uri.href}`);
      }
      if (!isSchemaReachable(schemaName, allowedSchemas)) {
        throw new Error(`Schema '${schemaName}' is not in the allowed schemas list`);
      }

      const [columns, constraints, indexes] = await Promise.all([
        pool.query(
          `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schemaName, tableName]
        ),
        pool.query(
          `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name,
                  ccu.table_schema AS foreign_table_schema,
                  ccu.table_name   AS foreign_table_name,
                  ccu.column_name  AS foreign_column_name
           FROM information_schema.table_constraints tc
           LEFT JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           LEFT JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
           WHERE tc.table_schema = $1 AND tc.table_name = $2`,
          [schemaName, tableName]
        ),
        pool.query(
          `SELECT i.relname AS index_name, a.attname AS column_name,
                  ix.indisunique AS is_unique, ix.indisprimary AS is_primary
           FROM pg_class t
           JOIN pg_index ix ON t.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
           JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = $1 AND t.relname = $2
           ORDER BY i.relname, a.attnum`,
          [schemaName, tableName]
        ),
      ]);

      if (columns.rows.length === 0) {
        throw new Error(`Table '${schemaName}.${tableName}' not found.`);
      }

      const payload = {
        schema: schemaName,
        table: tableName,
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        }],
      };
    }
  );
}
