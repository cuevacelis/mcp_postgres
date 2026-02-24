import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false,
  } : undefined,
  connectionTimeoutMillis: 10000,
});

export const allowedSchemas = process.env.DB_SCHEMAS
  ? process.env.DB_SCHEMAS.split(',').map((s) => s.trim())
  : [];

export const defaultLimit = parseInt(process.env.DEFAULT_LIMIT || '5');

export function isSchemaAllowed(schema: string): boolean {
  if (allowedSchemas.length === 0) return true;
  return allowedSchemas.includes(schema);
}
