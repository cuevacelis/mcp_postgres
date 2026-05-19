import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const SQL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid value for ${name}: expected 'true' or 'false', got '${value}'`);
}

function parseIntegerEnv(name: string, defaultValue: number, min: number, max: number): number {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === '' ? defaultValue : Number.parseInt(rawValue, 10);
  if (Number.isNaN(value) || value < min || value > max) {
    throw new Error(`Invalid value for ${name}: expected integer between ${min} and ${max}, got '${rawValue ?? defaultValue}'`);
  }
  return value;
}

function parseRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dbHost = process.env.DB_HOST?.trim() || 'localhost';
const dbPort = parseIntegerEnv('DB_PORT', 5432, 1, 65535);
const dbName = parseRequiredEnv('DB_NAME');
const dbUser = parseRequiredEnv('DB_USER');
const dbPassword = process.env.DB_PASSWORD;
const dbSsl = parseBooleanEnv('DB_SSL', false);
const dbSslRejectUnauthorized = parseBooleanEnv('DB_SSL_REJECT_UNAUTHORIZED', true);

const rawAllowedSchemas = process.env.DB_SCHEMAS
  ? process.env.DB_SCHEMAS.split(',').map((schema) => schema.trim()).filter(Boolean)
  : [];

for (const schema of rawAllowedSchemas) {
  if (!SQL_IDENTIFIER_REGEX.test(schema)) {
    throw new Error(`Invalid schema name in DB_SCHEMAS: '${schema}'. Use simple SQL identifiers only.`);
  }
}

export const allowedSchemas = [...new Set(rawAllowedSchemas)];
export const defaultLimit = parseIntegerEnv('DEFAULT_LIMIT', 5, 1, 100);

export const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: dbSsl ? { rejectUnauthorized: dbSslRejectUnauthorized } : undefined,
  connectionTimeoutMillis: 10000,
});

export function isSchemaAllowed(schema: string): boolean {
  if (allowedSchemas.length === 0) return true;
  return allowedSchemas.includes(schema);
}
