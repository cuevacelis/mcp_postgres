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

export function registerObjectTools(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[]
): void {
  server.registerTool(
    'postgres_list_functions',
    {
      title: 'List PostgreSQL Functions',
      description: 'Lista todas las funciones y procedimientos de un esquema con sus parámetros, tipo de retorno y lenguaje. Soporta paginación.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        limit: z.number().int().min(1).max(500).default(50).describe('Máximo de funciones a retornar (default: 50)'),
        offset: z.number().int().min(0).default(0).describe('Número de funciones a omitir para paginación (default: 0)'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, limit, offset }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const countResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*) as total
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1`,
        [schema]
      );
      const total = parseInt(countResult.rows[0].total);

      const result = await pool.query(
        `
        SELECT
          p.proname as function_name,
          pg_catalog.pg_get_function_arguments(p.oid) as arguments,
          pg_catalog.pg_get_function_result(p.oid) as return_type,
          CASE
            WHEN p.prokind = 'f' THEN 'function'
            WHEN p.prokind = 'p' THEN 'procedure'
            WHEN p.prokind = 'a' THEN 'aggregate'
            WHEN p.prokind = 'w' THEN 'window'
          END as function_type,
          l.lanname as language,
          pg_catalog.obj_description(p.oid, 'pg_proc') as description
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_language l ON l.oid = p.prolang
        WHERE n.nspname = $1
        ORDER BY p.proname
        LIMIT $2 OFFSET $3
        `,
        [schema, limit, offset]
      );

      const count = result.rows.length;
      return formatResult({
        schema,
        functions: result.rows,
        count,
        total,
        offset,
        has_more: total > offset + count,
        ...(total > offset + count ? { next_offset: offset + count } : {}),
      });
    }
  );

  server.registerTool(
    'postgres_get_function_definition',
    {
      title: 'Get Function Source Code',
      description: 'Obtiene la definición completa (código fuente) de una función o procedimiento almacenado.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        function_name: z.string().min(1).describe('Nombre de la función'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, function_name }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const result = await pool.query(
        `
        SELECT
          p.proname as function_name,
          pg_catalog.pg_get_functiondef(p.oid) as definition,
          pg_catalog.obj_description(p.oid, 'pg_proc') as description
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = $2
        `,
        [schema, function_name]
      );

      if (result.rows.length === 0) {
        throw new Error(`Function '${function_name}' not found in schema '${schema}'`);
      }

      return formatResult(result.rows[0]);
    }
  );

  server.registerTool(
    'postgres_list_triggers',
    {
      title: 'List PostgreSQL Triggers',
      description: 'Lista todos los triggers de un esquema con información sobre sus tablas, eventos y timing. Soporta paginación.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        limit: z.number().int().min(1).max(500).default(50).describe('Máximo de triggers a retornar (default: 50)'),
        offset: z.number().int().min(0).default(0).describe('Número de triggers a omitir para paginación (default: 0)'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, limit, offset }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const countResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*) as total FROM information_schema.triggers
         WHERE trigger_schema = $1`,
        [schema]
      );
      const total = parseInt(countResult.rows[0].total);

      const result = await pool.query(
        `
        SELECT
          t.trigger_name,
          t.event_manipulation as event,
          t.event_object_table as table_name,
          t.action_timing as timing,
          t.action_statement as action,
          pg_catalog.obj_description(
            (SELECT oid FROM pg_trigger WHERE tgname = t.trigger_name LIMIT 1),
            'pg_trigger'
          ) as description
        FROM information_schema.triggers t
        WHERE t.trigger_schema = $1
        ORDER BY t.event_object_table, t.trigger_name
        LIMIT $2 OFFSET $3
        `,
        [schema, limit, offset]
      );

      const count = result.rows.length;
      return formatResult({
        schema,
        triggers: result.rows,
        count,
        total,
        offset,
        has_more: total > offset + count,
        ...(total > offset + count ? { next_offset: offset + count } : {}),
      });
    }
  );

  server.registerTool(
    'postgres_get_trigger_definition',
    {
      title: 'Get Trigger Definition',
      description: 'Obtiene la definición completa de un trigger y su sentencia de acción asociada.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        trigger_name: z.string().min(1).describe('Nombre del trigger'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, trigger_name }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const result = await pool.query(
        `
        SELECT
          t.trigger_name,
          t.event_manipulation as event,
          t.event_object_table as table_name,
          t.action_timing as timing,
          t.action_statement as action,
          pg_get_triggerdef(
            (SELECT oid FROM pg_trigger WHERE tgname = t.trigger_name LIMIT 1)
          ) as trigger_definition
        FROM information_schema.triggers t
        WHERE t.trigger_schema = $1 AND t.trigger_name = $2
        `,
        [schema, trigger_name]
      );

      if (result.rows.length === 0) {
        throw new Error(`Trigger '${trigger_name}' not found in schema '${schema}'`);
      }

      return formatResult(result.rows[0]);
    }
  );
}
