#!/usr/bin/env npx ts-node

import { pool } from './src/db/pool.js';

async function testConnection() {
  console.log('=== Test de Conexión PostgreSQL ===\n');
  console.log('Configuración:');
  console.log(`  Host: ${process.env.DB_HOST}`);
  console.log(`  Port: ${process.env.DB_PORT}`);
  console.log(`  Database: ${process.env.DB_NAME}`);
  console.log(`  User: ${process.env.DB_USER}`);
  console.log(`  SSL: ${process.env.DB_SSL}`);
  console.log(`  Schemas permitidos: ${process.env.DB_SCHEMAS || 'todos'}\n`);

  try {
    // Test básico de conexión
    console.log('1. Probando conexión básica...');
    const result = await pool.query('SELECT NOW() as current_time, version() as version');
    console.log(`   ✓ Conexión exitosa!`);
    console.log(`   Hora del servidor: ${result.rows[0].current_time}`);
    console.log(`   Versión: ${result.rows[0].version.split(',')[0]}\n`);

    // Listar esquemas
    console.log('2. Listando esquemas disponibles...');
    const schemas = await pool.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);
    console.log(`   Esquemas encontrados: ${schemas.rows.map(r => r.schema_name).join(', ')}\n`);

    // Probar esquema configurado
    const configuredSchema = process.env.DB_SCHEMAS?.split(',')[0]?.trim();
    if (configuredSchema) {
      console.log(`3. Probando acceso al esquema '${configuredSchema}'...`);
      const tables = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name
        LIMIT 5
      `, [configuredSchema]);

      if (tables.rows.length > 0) {
        console.log(`   ✓ Tablas encontradas en '${configuredSchema}':`);
        tables.rows.forEach(t => console.log(`     - ${t.table_name}`));
        if (tables.rows.length === 5) {
          console.log('     ... (mostrando solo las primeras 5)');
        }
      } else {
        console.log(`   ⚠ No se encontraron tablas en el esquema '${configuredSchema}'`);
      }
    }

    console.log('\n=== Conexión verificada exitosamente ===');

  } catch (error) {
    console.error('\n✗ Error de conexión:');
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

testConnection();
