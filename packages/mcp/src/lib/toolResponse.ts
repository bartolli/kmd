/**
 * MCP CallToolResult helpers. `content[0].text` carries pretty-printed JSON
 * for LLM-facing clients; `structuredContent` carries the same payload as
 * raw JSON for clients that parse directly. Both fields kept in sync so
 * callers never choose one over the other.
 */

export function textJson(data: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>
  };
}

/**
 * Variant for tools whose model-facing surface is denser as markdown than as
 * pretty-printed JSON (~20% token savings on prose-heavy payloads). The
 * markdown goes to `content[0].text`; `structuredContent` keeps the machine
 * fields so a non-LLM client still gets a parseable shape.
 */
export function textWithStruct(markdown: string, data: object) {
  return {
    content: [{ type: 'text' as const, text: markdown }],
    structuredContent: data as Record<string, unknown>
  };
}

export interface ToolErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function textError(error: ToolErrorPayload) {
  const payload = {
    code: error.code,
    message: error.message,
    details: error.details ?? {}
  };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>
  };
}
