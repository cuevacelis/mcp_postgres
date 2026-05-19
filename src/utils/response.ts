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
    structuredContent: payload,
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

export function unwrapError(error: unknown): { message: string; code?: string; detail?: string } {
  if (error instanceof SchemaNotAllowedError) {
    return {
      message: error.message,
      code: 'SCHEMA_NOT_ALLOWED',
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
