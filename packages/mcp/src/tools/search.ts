import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { textError, textJson } from '../lib/toolResponse.js';

export const SearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query. Matched against title, summary, and body via SQLite FTS5.'
    ),
  scope: z
    .string()
    .optional()
    .describe('Optional: restrict to a project scope (e.g. "ontology", "sotto").'),
  kind: z
    .string()
    .optional()
    .describe(
      'Optional: restrict to a kind. Project kinds: spec, adr, plan, ops. Research kinds: article, src. Misc: note.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe('Maximum number of ranked results to return. Default 5.')
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export interface SearchResult {
  readonly path: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string | null;
  readonly score: number;
  readonly scope?: string | null;
}

export interface SearchDeps {
  readonly db: DatabaseSync;
}

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

function sanitizeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/["\-*():^]/g, ''))
    .filter((t) => t.length > 0 && !FTS5_KEYWORDS.has(t))
    .join(' ');
}

export function search(deps: SearchDeps, input: SearchInput): { results: SearchResult[] } {
  const ftsQuery = sanitizeFtsQuery(input.query);
  if (!ftsQuery) return { results: [] };

  let sql = `SELECT p.path, p.title, p.kind, p.summary, p.scope, bm25(pages_fts) AS score
     FROM pages_fts
     JOIN pages p ON p.id = pages_fts.rowid
     WHERE pages_fts MATCH ?`;
  const params: Array<string | number> = [ftsQuery];

  if (input.scope) {
    sql += ' AND p.scope = ?';
    params.push(input.scope);
  }
  if (input.kind) {
    sql += ' AND p.kind = ?';
    params.push(input.kind);
  }
  sql += ' ORDER BY bm25(pages_fts) LIMIT ?';
  params.push(input.limit);

  const rows = deps.db.prepare(sql).all(...params) as Array<{
    path: string;
    title: string;
    kind: string;
    summary: string | null;
    scope: string | null;
    score: number;
  }>;

  return {
    results: rows.map((r) => ({
      path: r.path,
      title: r.title,
      kind: r.kind,
      summary: r.summary,
      scope: r.scope,
      score: r.score
    }))
  };
}

export function handleSearch(deps: SearchDeps, input: SearchInput) {
  try {
    return textJson(search(deps, input));
  } catch (err) {
    return textError({
      code: 'SEARCH_FAILED',
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
