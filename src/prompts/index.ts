import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SQL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sqlIdentifier = z
  .string()
  .min(1)
  .regex(SQL_IDENTIFIER_REGEX, 'Only simple SQL identifiers are allowed (letters, digits, underscore).');

function assistantText(text: string) {
  return {
    role: 'user' as const,
    content: { type: 'text' as const, text },
  };
}

export function registerPrompts(server: McpServer, allowedSchemas: string[]): void {
  const allowedHint = allowedSchemas.length > 0
    ? `Allowed schemas: ${allowedSchemas.join(', ')}.`
    : 'No schema restriction is configured (all non-system schemas are reachable).';

  server.registerPrompt(
    'audit-table',
    {
      title: 'Audit a PostgreSQL table',
      description: 'Generates a structured audit prompt: describe the table, summarize storage stats, sample rows, list dependent triggers, and surface anomalies.',
      argsSchema: {
        schema: sqlIdentifier.describe('Schema where the table lives.'),
        table: sqlIdentifier.describe('Table to audit.'),
      },
    },
    ({ schema, table }) => ({
      messages: [
        assistantText(
          [
            `You are auditing the PostgreSQL table \`${schema}.${table}\`. ${allowedHint}`,
            '',
            'Run the following steps in order and produce a single concise report:',
            `1. Call \`postgres_describe_table\` for \`${schema}.${table}\` to get columns, constraints and indexes.`,
            `2. Call \`postgres_get_table_stats\` for \`${schema}.${table}\` and highlight: estimated row count, total size, dead/live tuple ratio, unused indexes (scans = 0), last vacuum/analyze.`,
            `3. Call \`postgres_query_table\` with limit=5 and no filters to sample real data and flag suspicious values (nulls in NOT NULL semantics, default sentinels, lookalike duplicates).`,
            `4. If the table has triggers, call \`postgres_list_triggers\` filtered on this table and fetch any non-obvious trigger via \`postgres_get_trigger_definition\`.`,
            '',
            'Report sections: **Schema**, **Storage & activity**, **Sample observations**, **Triggers**, **Risks / recommendations**.',
          ].join('\n')
        ),
      ],
    })
  );

  server.registerPrompt(
    'find-tables',
    {
      title: 'Find tables / columns by name pattern',
      description: 'Search for tables and columns whose names match a fuzzy pattern across the allowed schemas. Useful when the user does not know exact identifiers.',
      argsSchema: {
        pattern: z.string().min(1).describe('Name fragment to search for (e.g. "user", "email").'),
      },
    },
    ({ pattern }) => ({
      messages: [
        assistantText(
          [
            `Locate database objects related to "${pattern}". ${allowedHint}`,
            '',
            '1. Call `postgres_search_columns` with match_mode="contains" to find every column whose name contains the pattern.',
            '2. Group hits by `schema.table` and present them as a markdown table: schema | table | column | type | nullable.',
            '3. For up to 3 of the most promising tables (more than 2 column hits or names that match exactly), call `postgres_describe_table` and summarize how they look related to the user intent.',
            '4. End with one suggested follow-up query the user can run with `postgres_query_table`.',
          ].join('\n')
        ),
      ],
    })
  );

  server.registerPrompt(
    'explain-foreign-keys',
    {
      title: 'Explain foreign-key graph of a schema',
      description: 'Builds a textual ERD-like summary of the foreign-key relationships in a schema.',
      argsSchema: {
        schema: sqlIdentifier.describe('Schema to map.'),
      },
    },
    ({ schema }) => ({
      messages: [
        assistantText(
          [
            `Build a foreign-key map for schema \`${schema}\`. ${allowedHint}`,
            '',
            '1. Call `postgres_execute_query` with the following SQL (replace :schema with the value):',
            '```sql',
            'SELECT tc.table_name        AS child_table,',
            '       kcu.column_name      AS child_column,',
            '       ccu.table_name       AS parent_table,',
            '       ccu.column_name      AS parent_column,',
            '       tc.constraint_name',
            'FROM information_schema.table_constraints tc',
            'JOIN information_schema.key_column_usage kcu',
            '  ON tc.constraint_name = kcu.constraint_name',
            ' AND tc.table_schema    = kcu.table_schema',
            'JOIN information_schema.constraint_column_usage ccu',
            '  ON ccu.constraint_name = tc.constraint_name',
            ' AND ccu.table_schema    = tc.table_schema',
            `WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${schema}'`,
            'ORDER BY tc.table_name, kcu.column_name',
            'LIMIT 100',
            '```',
            '2. Present the result as `child_table.child_column → parent_table.parent_column` arrows, grouped by child table.',
            '3. Highlight orphan tables (no incoming or outgoing FKs) and obvious hubs (> 5 incoming FKs).',
          ].join('\n')
        ),
      ],
    })
  );

  server.registerPrompt(
    'profile-slow-query',
    {
      title: 'Profile a slow query',
      description: 'Runs EXPLAIN ANALYZE on a user-provided SELECT and proposes the top optimization wins (missing indexes, sequential scans, expensive sorts).',
      argsSchema: {
        sql: z.string().min(1).describe('SELECT / WITH statement to profile.'),
      },
    },
    ({ sql }) => ({
      messages: [
        assistantText(
          [
            'Profile the following query and recommend the highest-leverage optimization:',
            '```sql',
            sql,
            '```',
            '',
            '1. Call `postgres_explain_query` with analyze=true and format="json" on this SQL.',
            '2. From the plan, extract: total execution time, the 3 most expensive nodes (by actual time), and any Seq Scan over tables with > 10k rows.',
            '3. For each expensive table, call `postgres_describe_table` to inspect available indexes.',
            '4. Report a ranked list of recommendations (e.g. "Add index on `users(email)`", "Rewrite IN-subquery as JOIN"). Each recommendation should include the evidence from the plan.',
          ].join('\n')
        ),
      ],
    })
  );
}
