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

const functionRowSchema = z.object({
  function_name: z.string(),
  arguments: z.string(),
  return_type: z.string(),
  function_type: z.string().nullable(),
  language: z.string(),
  description: z.string().nullable(),
});

const listFunctionsOutput = {
  schema: z.string(),
  functions: z.array(functionRowSchema),
  count: z.number().int(),
  total: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
};

const functionDefinitionOutput = {
  function_name: z.string(),
  function_signature: z.string(),
  return_type: z.string(),
  definition: z.string(),
  description: z.string().nullable(),
};

const triggerRowSchema = z.object({
  trigger_name: z.string(),
  table_name: z.string(),
  event: z.string(),
  timing: z.string(),
  action: z.string(),
  description: z.string().nullable(),
});

const listTriggersOutput = {
  schema: z.string(),
  triggers: z.array(triggerRowSchema),
  count: z.number().int(),
  total: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
};

const triggerDefinitionOutput = {
  trigger_name: z.string(),
  table_name: z.string(),
  event: z.string(),
  timing: z.string(),
  action: z.string(),
  trigger_definition: z.string(),
};

export function registerObjectTools(
  server: McpServer,
  pool: Pool,
  allowedSchemas: string[]
): void {
  server.registerTool(
    'postgres_list_functions',
    {
      title: 'List PostgreSQL Functions',
      description: 'Lists every function, procedure, aggregate, and window function in a schema, with arguments, return type, language and pg_proc comments. Paginated.',
      inputSchema: {
        schema: sqlIdentifier.describe('Schema name.'),
        ...paginationFields,
      },
      outputSchema: listFunctionsOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, limit, offset }) => {
      try {
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
      } catch (error) {
        return toolError(`Failed to list functions in '${schema}'`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_get_function_definition',
    {
      title: 'Get Function Source Code',
      description: 'Returns the full source code (pg_get_functiondef) for a stored procedure or function. When the name is overloaded, pass function_signature to disambiguate (e.g. "integer, text").',
      inputSchema: {
        schema: sqlIdentifier.describe('Schema name.'),
        function_name: sqlIdentifier.describe('Function or procedure name.'),
        function_signature: z
          .string()
          .optional()
          .describe('Exact argument signature for overload disambiguation (e.g., "integer, text").'),
      },
      outputSchema: functionDefinitionOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, function_name, function_signature }) => {
      try {
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
          return toolError(`Function '${function_name}' not found in schema '${schema}'`);
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
            return toolError(
              `Overload '${function_name}(${normalizedSignature})' does not exist in schema '${schema}'.`,
              { available_signatures: availableSignatures }
            );
          }
          selected = matched;
        } else if (result.rows.length > 1) {
          const availableSignatures = result.rows.map(
            (row) => row.function_signature as string
          );
          return toolError(
            `Function '${function_name}' is overloaded in schema '${schema}'. Specify function_signature.`,
            { available_signatures: availableSignatures }
          );
        }

        return formatResult({
          function_name: selected.function_name,
          function_signature: selected.function_signature,
          return_type: selected.return_type,
          definition: selected.definition,
          description: selected.description,
        });
      } catch (error) {
        return toolError(`Failed to fetch definition of '${schema}.${function_name}'`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_list_triggers',
    {
      title: 'List PostgreSQL Triggers',
      description: 'Lists user-defined triggers in a schema with table, event (INSERT/UPDATE/DELETE), timing (BEFORE/AFTER) and action statement. Paginated. Internal/system triggers are excluded.',
      inputSchema: {
        schema: sqlIdentifier.describe('Schema name.'),
        ...paginationFields,
      },
      outputSchema: listTriggersOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, limit, offset }) => {
      try {
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
      } catch (error) {
        return toolError(`Failed to list triggers in '${schema}'`, unwrapError(error));
      }
    }
  );

  server.registerTool(
    'postgres_get_trigger_definition',
    {
      title: 'Get Trigger Definition',
      description: 'Returns the full CREATE TRIGGER statement (pg_get_triggerdef) plus its event/timing/action. If the same trigger name exists on several tables, pass table_name to disambiguate.',
      inputSchema: {
        schema: sqlIdentifier.describe('Schema name.'),
        trigger_name: sqlIdentifier.describe('Trigger name.'),
        table_name: sqlIdentifier
          .optional()
          .describe('Table name when the same trigger name is reused across tables.'),
      },
      outputSchema: triggerDefinitionOutput,
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ schema, trigger_name, table_name }) => {
      try {
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
          return toolError(
            `Trigger '${trigger_name}' not found in schema '${schema}'${table_name ? ` for table '${table_name}'` : ''}`
          );
        }

        if (!table_name && result.rows.length > 1) {
          const candidateTables = result.rows.map((row) => row.table_name as string);
          return toolError(
            `Trigger '${trigger_name}' exists on multiple tables of schema '${schema}'. Specify table_name.`,
            { candidate_tables: candidateTables }
          );
        }

        return formatResult(result.rows[0]);
      } catch (error) {
        return toolError(`Failed to fetch definition of trigger '${trigger_name}'`, unwrapError(error));
      }
    }
  );
}
