import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type McpToolResult = CallToolResult;

export const CHARACTER_LIMIT = 25000;

export function formatResult(data: unknown): McpToolResult {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CHARACTER_LIMIT) {
    return { content: [{ type: 'text', text }] };
  }
  const truncated = text.slice(0, CHARACTER_LIMIT);
  return {
    content: [{
      type: 'text',
      text: truncated + `\n\n...[RESPUESTA TRUNCADA: ${text.length} chars totales. Usa filtros de columnas, cláusula WHERE o paginación para reducir los resultados.]`,
    }],
  };
}

export function assertSchemaAllowed(schema: string, allowedSchemas: string[]): void {
  if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema)) {
    throw new Error(`Schema '${schema}' is not in the allowed schemas list`);
  }
}
