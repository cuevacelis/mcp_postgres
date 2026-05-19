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
      const total = Number.parseInt(countResult.rows[0].total, 10);

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
      description: 'Obtiene la definición completa (código fuente) de una función o procedimiento almacenado. Si hay sobrecarga, usa function_signature para desambiguar.',
      inputSchema: {
        schema: z.string().min(1).describe('Nombre del esquema'),
        function_name: z.string().min(1).describe('Nombre de la función'),
        function_signature: z
          .string()
          .optional()
          .describe('Firma exacta de argumentos para desambiguar sobrecargas (ej: "integer, text")'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, function_name, function_signature }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const result = await pool.query(
        `
        SELECT
          p.oid,
          p.proname as function_name,
          pg_catalog.pg_get_function_identity_arguments(p.oid) as function_signature,
          pg_catalog.pg_get_function_result(p.oid) as return_type,
          pg_catalog.pg_get_functiondef(p.oid) as definition,
          pg_catalog.obj_description(p.oid, 'pg_proc') as description
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = $2
        ORDER BY pg_catalog.pg_get_function_identity_arguments(p.oid)
        `,
        [schema, function_name]
      );

      if (result.rows.length === 0) {
        throw new Error(`Function '${function_name}' not found in schema '${schema}'`);
      }

      let selected = result.rows[0];
      if (function_signature) {
        const normalizedSignature = function_signature.trim();
        const matched = result.rows.find(
          (row) => (row.function_signature as string).trim() === normalizedSignature
        );
        if (!matched) {
          const availableSignatures = result.rows.map(
            (row) => row.function_signature as string
          );
          throw new Error(
            `No existe la sobrecarga '${function_name}(${normalizedSignature})' en el schema '${schema}'. Firmas disponibles: ${availableSignatures.join(' | ')}`
          );
        }
        selected = matched;
      } else if (result.rows.length > 1) {
        const availableSignatures = result.rows.map(
          (row) => row.function_signature as string
        );
        throw new Error(
          `La función '${function_name}' está sobrecargada en el schema '${schema}'. Especifica function_signature. Firmas disponibles: ${availableSignatures.join(' | ')}`
        );
      }

      return formatResult({
        function_name: selected.function_name,
        function_signature: selected.function_signature,
        return_type: selected.return_type,
        definition: selected.definition,
        description: selected.description,
      });
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
        `SELECT COUNT(*) as total
         FROM pg_catalog.pg_trigger tg
         JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND NOT tg.tgisinternal`,
        [schema]
      );
      const total = Number.parseInt(countResult.rows[0].total, 10);

      const result = await pool.query(
        `
        SELECT
          tg.tgname as trigger_name,
          c.relname as table_name,
          COALESCE(
            string_agg(DISTINCT t.event_manipulation, ' OR ' ORDER BY t.event_manipulation),
            'UNKNOWN'
          ) as event,
          COALESCE(MAX(t.action_timing), 'UNKNOWN') as timing,
          COALESCE(MAX(t.action_statement), pg_catalog.pg_get_triggerdef(tg.oid)) as action,
          pg_catalog.obj_description(tg.oid, 'pg_trigger') as description
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN information_schema.triggers t
          ON t.trigger_name = tg.tgname
          AND t.event_object_table = c.relname
          AND t.event_object_schema = n.nspname
        WHERE n.nspname = $1 AND NOT tg.tgisinternal
        GROUP BY tg.oid, tg.tgname, c.relname
        ORDER BY c.relname, tg.tgname
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
        table_name: z
          .string()
          .min(1)
          .optional()
          .describe('Nombre de la tabla si el trigger existe con el mismo nombre en múltiples tablas'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, trigger_name, table_name }) => {
      assertSchemaAllowed(schema, allowedSchemas);

      const params: string[] = [schema, trigger_name];
      let tableFilter = '';
      if (table_name) {
        params.push(table_name);
        tableFilter = ` AND c.relname = $${params.length}`;
      }

      const result = await pool.query(
        `
        SELECT
          tg.tgname as trigger_name,
          c.relname as table_name,
          COALESCE(
            string_agg(DISTINCT t.event_manipulation, ' OR ' ORDER BY t.event_manipulation),
            'UNKNOWN'
          ) as event,
          COALESCE(MAX(t.action_timing), 'UNKNOWN') as timing,
          COALESCE(MAX(t.action_statement), pg_catalog.pg_get_triggerdef(tg.oid)) as action,
          pg_catalog.pg_get_triggerdef(tg.oid) as trigger_definition
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN information_schema.triggers t
          ON t.trigger_name = tg.tgname
          AND t.event_object_table = c.relname
          AND t.event_object_schema = n.nspname
        WHERE n.nspname = $1
          AND tg.tgname = $2
          AND NOT tg.tgisinternal
          ${tableFilter}
        GROUP BY tg.oid, tg.tgname, c.relname
        ORDER BY c.relname
        `,
        params
      );

      if (result.rows.length === 0) {
        throw new Error(
          `Trigger '${trigger_name}' not found in schema '${schema}'${table_name ? ` for table '${table_name}'` : ''}`
        );
      }

      if (!table_name && result.rows.length > 1) {
        const candidateTables = result.rows.map((row) => row.table_name as string);
        throw new Error(
          `El trigger '${trigger_name}' existe en múltiples tablas del schema '${schema}'. Especifica table_name. Tablas: ${candidateTables.join(', ')}`
        );
      }

      return formatResult(result.rows[0]);
    }
  );
}
