import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import type { Pool } from 'pg';
import { z } from 'zod';
import { textError, textWithStruct } from '../lib/toolResponse.js';

export const PrimeInputSchema = z.object({
  scope: z
    .string()
    .min(1)
    .describe('Project scope to prime (matches projects/{scope}/ in the vault).'),
  task: z
    .string()
    .optional()
    .describe('Optional task description; surfaces top-3 tsvector-ranked relevant pages.')
});

export type PrimeInput = z.infer<typeof PrimeInputSchema>;

interface ProjectIndexFm {
  title?: string;
  methodology?: string;
  phase?: number;
  summary?: string;
}

interface PrimeData {
  scope: string;
  title: string | null;
  methodology: string | null;
  phase: number | null;
  summary: string;
  primer: string;
  counts: Record<string, number>;
  active_adrs: Array<{ path: string; slug: string; title: string; summary: string | null }>;
  current_plan: { path: string; slug: string; title: string } | null;
  top_tags: string[];
  hub_pages: Array<{ path: string; title: string; inbound: number }>;
  recent: Array<{ path: string; operation: string; date: string }>;
  relevant: Array<{ path: string; title: string; score: number }>;
  cross_scope: Array<{ from_scope: string; from_path: string; to_path: string }>;
}

export interface PrimeDeps {
  readonly pool: Pool;
  readonly vaultRoot: string;
}

function pathSlug(p: string): string {
  return basename(p).replace(/\.md$/, '');
}

async function readIndexFm(vaultRoot: string, scope: string): Promise<ProjectIndexFm> {
  try {
    const raw = await readFile(join(vaultRoot, 'projects', scope, 'index.md'), 'utf8');
    return matter(raw).data as ProjectIndexFm;
  } catch {
    return {};
  }
}

async function readPrimer(vaultRoot: string, scope: string): Promise<string> {
  try {
    const raw = await readFile(join(vaultRoot, 'projects', scope, 'primer.md'), 'utf8');
    // Strip the file's own H1 (e.g., "# Primer" / "# Session Primer") — the
    // primer is inlined under a `## Primer` section header in the response,
    // so the file's own H1 is redundant when nested.
    return matter(raw)
      .content.trim()
      .replace(/^#\s+[^\n]+\n+/, '');
  } catch {
    return '';
  }
}

export async function prime(
  deps: PrimeDeps,
  input: PrimeInput
): Promise<{ markdown: string; data: PrimeData }> {
  const { pool, vaultRoot } = deps;
  const { scope, task } = input;

  const [fm, primer] = await Promise.all([
    readIndexFm(vaultRoot, scope),
    readPrimer(vaultRoot, scope)
  ]);

  const [counts, adrs, planRow, tags, hubs, events, crossScope] = await Promise.all([
    pool.query<{ kind: string; count: string }>(
      "SELECT kind, count(*)::text AS count FROM pages WHERE scope = $1 GROUP BY kind",
      [scope]
    ),
    pool.query<{ path: string; title: string; summary: string | null }>(
      "SELECT path, title, summary FROM pages WHERE scope = $1 AND kind = 'adr' AND status = 'active' ORDER BY updated DESC NULLS LAST",
      [scope]
    ),
    pool.query<{ path: string; title: string }>(
      "SELECT path, title FROM pages WHERE scope = $1 AND kind = 'plan' AND status = 'active' ORDER BY updated DESC NULLS LAST LIMIT 1",
      [scope]
    ),
    pool.query<{ tag: string }>(
      "SELECT tag FROM pages, unnest(tags) AS tag WHERE scope = $1 GROUP BY tag ORDER BY count(*) DESC LIMIT 10",
      [scope]
    ),
    pool.query<{ path: string; title: string; inbound: string }>(
      `SELECT p.path, p.title, count(*)::text AS inbound
       FROM links l JOIN pages p ON p.path = l.target_path
       WHERE p.scope = $1
       GROUP BY p.path, p.title
       ORDER BY count(*) DESC LIMIT 5`,
      [scope]
    ),
    pool.query<{ path: string; operation: string; ts: Date }>(
      "SELECT path, operation, ts FROM events WHERE scope = $1 ORDER BY ts DESC LIMIT 5",
      [scope]
    ),
    pool.query<{ from_scope: string; from_path: string; to_path: string }>(
      `SELECT pf.scope AS from_scope, l.source_path AS from_path, l.target_path AS to_path
       FROM links l
       JOIN pages pt ON pt.path = l.target_path
       JOIN pages pf ON pf.path = l.source_path
       WHERE pt.scope = $1 AND pf.scope IS NOT NULL AND pf.scope != $1
       LIMIT 10`,
      [scope]
    )
  ]);

  let relevant: Array<{ path: string; title: string; score: number }> = [];
  if (task) {
    const r = await pool.query<{ path: string; title: string; score: string }>(
      `SELECT path, title,
              ts_rank(search_vec, plainto_tsquery('english', $2))::text AS score
       FROM pages
       WHERE scope = $1 AND search_vec @@ plainto_tsquery('english', $2)
       ORDER BY score DESC LIMIT 3`,
      [scope, task]
    );
    relevant = r.rows.map((row) => ({
      path: row.path,
      title: row.title,
      score: Number(row.score)
    }));
  }

  const countsRecord: Record<string, number> = {};
  for (const row of counts.rows) countsRecord[row.kind] = Number(row.count);

  const data: PrimeData = {
    scope,
    title: fm.title ?? null,
    methodology: fm.methodology ?? null,
    phase: typeof fm.phase === 'number' ? fm.phase : null,
    summary: fm.summary ?? '',
    primer,
    counts: countsRecord,
    active_adrs: adrs.rows.map((r) => ({
      path: r.path,
      slug: pathSlug(r.path),
      title: r.title,
      summary: r.summary
    })),
    current_plan: planRow.rows[0]
      ? {
          path: planRow.rows[0].path,
          slug: pathSlug(planRow.rows[0].path),
          title: planRow.rows[0].title
        }
      : null,
    top_tags: tags.rows.map((r) => r.tag),
    hub_pages: hubs.rows.map((r) => ({
      path: r.path,
      title: r.title,
      inbound: Number(r.inbound)
    })),
    recent: events.rows.map((r) => ({
      path: r.path,
      operation: r.operation,
      date: r.ts.toISOString().slice(0, 10)
    })),
    relevant,
    cross_scope: crossScope.rows.map((r) => ({
      from_scope: r.from_scope,
      from_path: r.from_path,
      to_path: r.to_path
    }))
  };

  return { markdown: renderMarkdown(data, task), data };
}

function renderMarkdown(d: PrimeData, task: string | undefined): string {
  const lines: string[] = [];

  const phaseLabel =
    d.phase !== null
      ? d.methodology
        ? `Phase ${d.phase} (${d.methodology})`
        : `Phase ${d.phase}`
      : '';
  const header = phaseLabel ? `${d.scope} — ${phaseLabel}` : d.scope;
  lines.push(`# ${header}`);
  if (d.summary) lines.push(d.summary);

  if (d.primer) {
    lines.push('', '## Primer', d.primer);
  }

  if (d.active_adrs.length > 0) {
    lines.push('', '## Active Decisions');
    for (const a of d.active_adrs) {
      lines.push(`- ${a.slug}: ${a.summary ?? a.title}`);
    }
  }

  if (d.current_plan) {
    lines.push('', '## Current Plan');
    lines.push(`${d.current_plan.slug}: ${d.current_plan.title}`);
  }

  const countEntries = Object.entries(d.counts);
  if (countEntries.length > 0) {
    lines.push('', '## Pages');
    lines.push(countEntries.map(([k, n]) => `${k}: ${n}`).join(' | '));
  }

  if (d.top_tags.length > 0) {
    lines.push('', '## Tags');
    lines.push(d.top_tags.join(', '));
  }

  if (d.hub_pages.length > 0) {
    lines.push('', '## Hubs');
    for (const h of d.hub_pages) {
      lines.push(`- ${pathSlug(h.path)} (${h.inbound} inbound)`);
    }
  }

  if (d.recent.length > 0) {
    lines.push('', '## Recent');
    for (const r of d.recent) {
      lines.push(`- [${r.date}] ${pathSlug(r.path)} ${r.operation}`);
    }
  }

  if (d.relevant.length > 0) {
    lines.push('', `## Relevant (task: "${task}")`);
    for (const r of d.relevant) {
      lines.push(`- ${pathSlug(r.path)} (${r.score.toFixed(2)})`);
    }
  }

  if (d.cross_scope.length > 0) {
    lines.push('', '## Cross-scope');
    for (const c of d.cross_scope) {
      lines.push(`- ${c.from_scope}/${pathSlug(c.from_path)} → ${pathSlug(c.to_path)}`);
    }
  }

  return lines.join('\n');
}

export async function handlePrime(deps: PrimeDeps, input: PrimeInput) {
  try {
    const { markdown, data } = await prime(deps, input);
    return textWithStruct(markdown, data as unknown as Record<string, unknown>);
  } catch (err) {
    return textError({
      code: 'PRIME_FAILED',
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
