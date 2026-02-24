#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pool, allowedSchemas, defaultLimit } from './db/pool.js';
import { createServer } from './server.js';

async function main() {
  console.error('Iniciando servidor MCP PostgreSQL...');

  const server = createServer(pool, allowedSchemas, defaultLimit);
  const transport = new StdioServerTransport();
  console.error('Transporte STDIO creado');

  await server.connect(transport);
  console.error('Servidor conectado al transporte');

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
