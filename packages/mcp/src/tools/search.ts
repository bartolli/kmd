import type { Pool } from 'pg';
import { z } from 'zod';
import { textError, textJson } from '../lib/toolResponse.js';

export const SearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query. Matched against title, summary, and body via Postgres tsvector.'
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
}

export interface SearchDeps {
  readonly pool: Pool;
}

export async function search(
  deps: SearchDeps,
  input: SearchInput
): Promise<{ results: SearchResult[] }> {
  const clauses: string[] = ["search_vec @@ plainto_tsquery('english', $1)"];
  const params: unknown[] = [input.query];

  if (input.scope) {
    params.push(input.scope);
    clauses.push(`scope = $${params.length}`);
  }
  if (input.kind) {
    params.push(input.kind);
    clauses.push(`kind = $${params.length}`);
  }
  params.push(input.limit);

  const { rows } = await deps.pool.query<{
    path: string;
    title: string;
    kind: string;
    summary: string | null;
    score: string;
  }>(
    `SELECT path, title, kind, summary,
            ts_rank(search_vec, plainto_tsquery('english', $1))::text AS score
     FROM pages
     WHERE ${clauses.join(' AND ')}
     ORDER BY score DESC
     LIMIT $${params.length}`,
    params
  );

  return {
    results: rows.map((r) => ({
      path: r.path,
      title: r.title,
      kind: r.kind,
      summary: r.summary,
      score: Number(r.score)
    }))
  };
}

export async function handleSearch(deps: SearchDeps, input: SearchInput) {
  try {
    return textJson(await search(deps, input));
  } catch (err) {
    return textError({
      code: 'SEARCH_FAILED',
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
