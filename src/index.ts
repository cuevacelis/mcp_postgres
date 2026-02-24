#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false, // For cloud databases like AWS RDS
  } : undefined,
  connectionTimeoutMillis: 10000, // 10 segundos de timeout para conexión
});

// Configuración de esquemas permitidos
const allowedSchemas = process.env.DB_SCHEMAS
  ? process.env.DB_SCHEMAS.split(',').map((s) => s.trim())
  : [];

const defaultLimit = parseInt(process.env.DEFAULT_LIMIT || '5');

// Verificar si un esquema está permitido
function isSchemaAllowed(schema: string): boolean {
  if (allowedSchemas.length === 0) return true;
  return allowedSchemas.includes(schema);
}

// Definición de herramientas MCP
const tools: Tool[] = [
  {
    name: 'list_schemas',
    description: 'Lista todos los esquemas disponibles en la base de datos PostgreSQL',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_tables',
    description: 'Lista todas las tablas de un esquema específico con sus descripciones',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema (ej: public, schema1)',
        },
      },
      required: ['schema'],
    },
  },
  {
    name: 'describe_table',
    description: 'Describe la estructura completa de una tabla (columnas, tipos, constraints)',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema',
        },
        table: {
          type: 'string',
          description: 'Nombre de la tabla',
        },
      },
      required: ['schema', 'table'],
    },
  },
  {
    name: 'list_functions',
    description: 'Lista todas las funciones de un esquema con sus parámetros y tipo de retorno',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema',
        },
      },
      required: ['schema'],
    },
  },
  {
    name: 'list_triggers',
    description: 'Lista todos los triggers de un esquema con información sobre sus tablas y eventos',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema',
        },
      },
      required: ['schema'],
    },
  },
  {
    name: 'query_table',
    description: 'Ejecuta una consulta SELECT simple en una sola tabla con LIMIT automático. Para JOINs, subqueries, CTEs o consultas multi-tabla, usa execute_query.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema',
        },
        table: {
          type: 'string',
          description: 'Nombre de la tabla',
        },
        columns: {
          type: 'string',
          description: 'Columnas a seleccionar (ej: "id, name" o "*" para todas)',
          default: '*',
        },
        where: {
          type: 'string',
          description: 'Cláusula WHERE opcional (sin incluir la palabra WHERE)',
        },
        limit: {
          type: 'number',
          description: `Número máximo de registros a retornar (default: ${defaultLimit})`,
        },
      },
      required: ['schema', 'table'],
    },
  },
  {
    name: 'execute_query',
    description: 'Ejecuta una consulta SQL SELECT completa de solo lectura. Soporta JOINs, subqueries, CTEs (WITH), funciones de agregación, UNION y operaciones multi-tabla. Solo se permiten consultas SELECT/WITH. Tiene un timeout de 30 segundos y un límite máximo de 100 filas.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta SQL SELECT completa (ej: SELECT a.*, b.name FROM schema1.table1 a JOIN schema1.table2 b ON a.id = b.id)',
        },
        limit: {
          type: 'number',
          description: `Límite máximo de filas a retornar (default: ${defaultLimit}, max: 100)`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_function_definition',
    description: 'Obtiene la definición completa (código fuente) de una función',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema',
        },
        function_name: {
          type: 'string',
          description: 'Nombre de la función',
        },
      },
      required: ['schema', 'function_name'],
    },
  },
  {
    name: 'get_trigger_definition',
    description: 'Obtiene la definición completa de un trigger y su función asociada',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Nombre del esquema',
        },
        trigger_name: {
          type: 'string',
          description: 'Nombre del trigger',
        },
      },
      required: ['schema', 'trigger_name'],
    },
  },
];

// Implementación de las herramientas
async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case 'list_schemas': {
      const result = await pool.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY schema_name
      `);

      const schemas = result.rows.map((row) => row.schema_name);
      const filtered = allowedSchemas.length > 0
        ? schemas.filter((s) => isSchemaAllowed(s))
        : schemas;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                schemas: filtered,
                total: filtered.length,
                configured_schemas: allowedSchemas.length > 0 ? allowedSchemas : 'all',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'list_tables': {
      const { schema } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

      const result = await pool.query(
        `
        SELECT
          t.table_name,
          pg_catalog.obj_description(pgc.oid, 'pg_class') as table_description,
          (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) as column_count
        FROM information_schema.tables t
        LEFT JOIN pg_catalog.pg_class pgc ON pgc.relname = t.table_name
        LEFT JOIN pg_catalog.pg_namespace pgn ON pgn.oid = pgc.relnamespace AND pgn.nspname = t.table_schema
        WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `,
        [schema]
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                schema: schema,
                tables: result.rows,
                total: result.rows.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'describe_table': {
      const { schema, table } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

      // Obtener columnas
      const columnsResult = await pool.query(
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
        LEFT JOIN pg_catalog.pg_namespace pgn ON pgn.oid = pgc.relnamespace AND pgn.nspname = c.table_schema
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
      `,
        [schema, table]
      );

      // Obtener constraints (primary keys, foreign keys, unique)
      const constraintsResult = await pool.query(
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
      );

      // Obtener índices
      const indexesResult = await pool.query(
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
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                schema: schema,
                table: table,
                columns: columnsResult.rows,
                constraints: constraintsResult.rows,
                indexes: indexesResult.rows,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'list_functions': {
      const { schema } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

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
      `,
        [schema]
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                schema: schema,
                functions: result.rows,
                total: result.rows.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'list_triggers': {
      const { schema } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

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
      `,
        [schema]
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                schema: schema,
                triggers: result.rows,
                total: result.rows.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'query_table': {
      const { schema, table, columns = '*', where, limit = defaultLimit } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

      // Construir query de forma segura
      const safeLimit = Math.min(Math.max(1, limit), 100); // Entre 1 y 100
      let query = `SELECT ${columns} FROM "${schema}"."${table}"`;

      const params: any[] = [];
      if (where) {
        query += ` WHERE ${where}`;
      }

      query += ` LIMIT $${params.length + 1}`;
      params.push(safeLimit);

      const result = await pool.query(query, params);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                schema: schema,
                table: table,
                query: query,
                rows: result.rows,
                row_count: result.rows.length,
                limit: safeLimit,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'execute_query': {
      const { query, limit = defaultLimit } = args;

      // Normalizar la query para validación
      const normalizedQuery = query.trim().toLowerCase();

      // Validar que sea solo SELECT o WITH (CTE)
      if (!normalizedQuery.startsWith('select') && !normalizedQuery.startsWith('with')) {
        throw new Error('Solo se permiten consultas SELECT o WITH (CTE). No se permiten INSERT, UPDATE, DELETE, DROP, ALTER, CREATE u otras operaciones de modificación.');
      }

      // Lista de keywords prohibidos para prevenir modificaciones
      const forbiddenKeywords = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'execute', 'copy'];
      // Usar word boundary regex para evitar falsos positivos (ej: "delete_date" como nombre de columna)
      for (const keyword of forbiddenKeywords) {
        const regex = new RegExp(`\\b${keyword}\\b\\s+(into|from|table|schema|database|index|function|procedure|trigger|role|user|privileges|on|all)\\b`, 'i');
        if (regex.test(query)) {
          throw new Error(`Operación no permitida: la query contiene '${keyword}' seguido de un contexto de modificación. Solo se permiten consultas de lectura (SELECT/WITH).`);
        }
      }

      // La validación de esquemas se hace a nivel de PostgreSQL usando search_path
      // Esto evita falsos positivos con alias de tabla (ej: a.id, b.name)

      // Manejar LIMIT
      const safeLimit = Math.min(Math.max(1, limit), 100);
      let finalQuery = query.trim();

      // Verificar si la query ya tiene LIMIT
      const hasLimit = /\bLIMIT\s+\d+/i.test(finalQuery);
      if (!hasLimit) {
        // Si no tiene LIMIT, agregar uno
        finalQuery = `${finalQuery} LIMIT ${safeLimit}`;
      } else {
        // Si tiene LIMIT, extraer el valor y usar el menor
        const limitMatch = finalQuery.match(/\bLIMIT\s+(\d+)/i);
        if (limitMatch) {
          const userLimit = parseInt(limitMatch[1]);
          const effectiveLimit = Math.min(userLimit, 100);
          finalQuery = finalQuery.replace(/\bLIMIT\s+\d+/i, `LIMIT ${effectiveLimit}`);
        }
      }

      // Ejecutar con statement_timeout de 30 segundos
      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 30000');
        if (allowedSchemas.length > 0) {
          const searchPath = allowedSchemas.map(s => `"${s}"`).join(', ');
          await client.query(`SET search_path = ${searchPath}`);
        }
        const result = await client.query(finalQuery);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query: finalQuery,
                  rows: result.rows,
                  row_count: result.rows.length,
                  fields: result.fields.map((f: any) => f.name),
                },
                null,
                2
              ),
            },
          ],
        };
      } finally {
        client.release();
      }
    }

    case 'get_function_definition': {
      const { schema, function_name } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows[0], null, 2),
          },
        ],
      };
    }

    case 'get_trigger_definition': {
      const { schema, trigger_name } = args;

      if (!isSchemaAllowed(schema)) {
        throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
      }

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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows[0], null, 2),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Crear el servidor MCP
const server = new Server(
  {
    name: 'mcp-postgres',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Registrar handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleToolCall(request.params.name, request.params.arguments);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Iniciar el servidor
async function main() {
  console.error('Iniciando servidor MCP PostgreSQL...');

  const transport = new StdioServerTransport();
  console.error('Transporte STDIO creado');

  await server.connect(transport);
  console.error('Servidor conectado al transporte');

  // Verificar conexión a la base de datos
  console.error('Verificando conexión a la base de datos...');
  try {
    await pool.query('SELECT 1');
    console.error('✓ Conexión a PostgreSQL establecida');
    console.error('Servidor MCP listo para recibir solicitudes');
  } catch (error) {
    console.error('✗ Error al conectar a PostgreSQL:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error fatal:', error);
  process.exit(1);
});
