const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

export function sanitizeFtsQuery(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FTS5_KEYWORDS.has(t))
    .join(' ');
}
