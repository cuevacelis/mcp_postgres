import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type McpToolResult = CallToolResult;

export const CHARACTER_LIMIT = 25000;

export function formatResult<T>(data: T): McpToolResult {
  const text = JSON.stringify(data, null, 2);
  const isStructurable = typeof data === 'object' && data !== null && !Array.isArray(data);

  if (text.length <= CHARACTER_LIMIT) {
    return {
      content: [{ type: 'text', text }],
      ...(isStructurable ? { structuredContent: data as Record<string, unknown> } : {}),
    };
  }

  const truncated = text.slice(0, CHARACTER_LIMIT);
  return {
    content: [{
      type: 'text',
      text: truncated + `\n\n...[RESPONSE TRUNCATED: ${text.length} total chars. Use column filters, a WHERE clause, or pagination to reduce the result size.]`,
    }],
  };
}

export function toolError(message: string, details?: Record<string, unknown>): McpToolResult {
  const payload = details ? { error: message, ...details } : { error: message };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function assertSchemaAllowed(schema: string, allowedSchemas: string[]): void {
  if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema)) {
    throw new SchemaNotAllowedError(schema, allowedSchemas);
  }
}

export class SchemaNotAllowedError extends Error {
  readonly schema: string;
  readonly allowedSchemas: readonly string[];
  constructor(schema: string, allowedSchemas: readonly string[]) {
    super(`Schema '${schema}' is not in the allowed schemas list`);
    this.name = 'SchemaNotAllowedError';
    this.schema = schema;
    this.allowedSchemas = allowedSchemas;
  }
}

export class SchemaRequiredError extends Error {
  readonly allowedSchemas: readonly string[];
  constructor(allowedSchemas: readonly string[]) {
    const hint = allowedSchemas.length === 0
      ? 'No DB_SCHEMAS configured. Call postgres_list_schemas to discover available schemas, then pass `schema` explicitly.'
      : `Pass one of: ${allowedSchemas.join(', ')}.`;
    super(`Argument 'schema' is required. ${hint}`);
    this.name = 'SchemaRequiredError';
    this.allowedSchemas = allowedSchemas;
  }
}

export function resolveSchema(provided: string | undefined, allowedSchemas: string[]): string {
  if (provided !== undefined && provided !== '') {
    assertSchemaAllowed(provided, allowedSchemas);
    return provided;
  }
  if (allowedSchemas.length === 1) {
    return allowedSchemas[0];
  }
  throw new SchemaRequiredError(allowedSchemas);
}

export function buildSchemaDescription(allowedSchemas: string[]): string {
  if (allowedSchemas.length === 0) {
    return 'Schema name. Required — no DB_SCHEMAS is configured, so call postgres_list_schemas first if unknown.';
  }
  if (allowedSchemas.length === 1) {
    return `Schema name. Optional — defaults to '${allowedSchemas[0]}' (the only schema configured in DB_SCHEMAS).`;
  }
  return `Schema name. Must be one of the configured schemas: ${allowedSchemas.map((s) => `'${s}'`).join(', ')}.`;
}

export function unwrapError(error: unknown): { message: string; code?: string; detail?: string } {
  if (error instanceof SchemaNotAllowedError) {
    return {
      message: error.message,
      code: 'SCHEMA_NOT_ALLOWED',
      detail: `Allowed schemas: ${error.allowedSchemas.length > 0 ? error.allowedSchemas.join(', ') : '(all)'}`,
    };
  }
  if (error instanceof SchemaRequiredError) {
    return {
      message: error.message,
      code: 'SCHEMA_REQUIRED',
      detail: `Allowed schemas: ${error.allowedSchemas.length > 0 ? error.allowedSchemas.join(', ') : '(all)'}`,
    };
  }
  if (error instanceof Error) {
    const pgCode = (error as { code?: unknown }).code;
    return {
      message: error.message,
      ...(typeof pgCode === 'string' ? { code: pgCode } : {}),
    };
  }
  return { message: String(error) };
}
