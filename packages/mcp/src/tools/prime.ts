import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseFrontmatter } from '../frontmatter.js';
import { sanitizeFtsQuery } from '../lib/fts.js';
import { textError, textWithStruct } from '../lib/toolResponse.js';
import type { VaultConfig } from '../vault-config.js';

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

export interface PrimeData {
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
  readonly db: DatabaseSync;
  readonly vaultRoot: string;
  readonly vaultConfig: VaultConfig;
}

function pathSlug(p: string): string {
  return basename(p).replace(/\.md$/, '');
}

async function readIndexFm(vaultRoot: string, scope: string): Promise<ProjectIndexFm> {
  try {
    const raw = await readFile(join(vaultRoot, 'projects', scope, 'index.md'), 'utf8');
    return parseFrontmatter(raw).data as ProjectIndexFm;
  } catch {
    return {};
  }
}

async function readPrimer(vaultRoot: string, scope: string): Promise<string> {
  try {
    const raw = await readFile(join(vaultRoot, 'projects', scope, 'primer.md'), 'utf8');
    return parseFrontmatter(raw)
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
  const { db, vaultRoot, vaultConfig } = deps;
  const { scope, task } = input;

  const [fm, primer] = await Promise.all([
    readIndexFm(vaultRoot, scope),
    readPrimer(vaultRoot, scope)
  ]);

  const counts = db
    .prepare('SELECT kind, count(*) AS count FROM pages WHERE scope = ? GROUP BY kind')
    .all(scope) as Array<{ kind: string; count: number | bigint }>;

  const adrs = db
    .prepare(
      "SELECT path, title, summary FROM pages WHERE scope = ? AND kind = 'adr' AND status = 'active' ORDER BY updated DESC"
    )
    .all(scope) as Array<{ path: string; title: string; summary: string | null }>;

  const planRow = db
    .prepare(
      "SELECT path, title FROM pages WHERE scope = ? AND kind = 'plan' AND status = 'active' ORDER BY updated DESC LIMIT 1"
    )
    .get(scope) as { path: string; title: string } | undefined;

  const tags = db
    .prepare(
      `SELECT j.value AS tag, count(*) AS cnt
       FROM pages, json_each(pages.tags) AS j
       WHERE scope = ?
       GROUP BY j.value
       ORDER BY cnt DESC
       LIMIT 10`
    )
    .all(scope) as Array<{ tag: string }>;

  const hubs = db
    .prepare(
      `SELECT p.path, p.title, count(*) AS inbound
       FROM links l JOIN pages p ON p.path = l.target_path
       WHERE p.scope = ?
       GROUP BY p.path, p.title
       ORDER BY inbound DESC LIMIT 5`
    )
    .all(scope) as Array<{ path: string; title: string; inbound: number | bigint }>;

  const events = db
    .prepare('SELECT path, operation, ts FROM events WHERE scope = ? ORDER BY ts DESC LIMIT 5')
    .all(scope) as Array<{ path: string; operation: string; ts: string }>;

  const crossScope = db
    .prepare(
      `SELECT pf.scope AS from_scope, l.source_path AS from_path, l.target_path AS to_path
       FROM links l
       JOIN pages pt ON pt.path = l.target_path
       JOIN pages pf ON pf.path = l.source_path
       WHERE pt.scope = ? AND pf.scope IS NOT NULL AND pf.scope != ?
       LIMIT 10`
    )
    .all(scope, scope) as Array<{ from_scope: string; from_path: string; to_path: string }>;

  let relevant: Array<{ path: string; title: string; score: number }> = [];
  if (task) {
    const ftsQuery = sanitizeFtsQuery(task);
    if (ftsQuery) {
      relevant = (
        db
          .prepare(
            `SELECT p.path, p.title, bm25(pages_fts) AS score
             FROM pages_fts
             JOIN pages p ON p.id = pages_fts.rowid
             WHERE pages_fts MATCH ? AND p.scope = ?
             ORDER BY bm25(pages_fts) LIMIT 3`
          )
          .all(ftsQuery, scope) as Array<{ path: string; title: string; score: number }>
      ).map((row) => ({
        path: row.path,
        title: row.title,
        score: row.score
      }));
    }
  }

  const countsRecord: Record<string, number> = {};
  for (const row of counts) countsRecord[row.kind] = Number(row.count);

  const data: PrimeData = {
    scope,
    title: fm.title ?? null,
    methodology: fm.methodology ?? null,
    phase: typeof fm.phase === 'number' ? fm.phase : null,
    summary: fm.summary ?? '',
    primer,
    counts: countsRecord,
    active_adrs: adrs.map((r) => ({
      path: r.path,
      slug: pathSlug(r.path),
      title: r.title,
      summary: r.summary
    })),
    current_plan: planRow
      ? {
          path: planRow.path,
          slug: pathSlug(planRow.path),
          title: planRow.title
        }
      : null,
    top_tags: tags.map((r) => r.tag),
    hub_pages: hubs.map((r) => ({
      path: r.path,
      title: r.title,
      inbound: Number(r.inbound)
    })),
    recent: events.map((r) => ({
      path: r.path,
      operation: r.operation,
      date: r.ts.slice(0, 10)
    })),
    relevant,
    cross_scope: crossScope.map((r) => ({
      from_scope: r.from_scope,
      from_path: r.from_path,
      to_path: r.to_path
    }))
  };

  return { markdown: renderMarkdown(data, vaultConfig, task), data };
}

export function renderMarkdown(
  d: PrimeData,
  config: VaultConfig,
  task: string | undefined
): string {
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

  lines.push('', '## Vocabulary');
  lines.push(`kinds: ${config.kinds.join(', ')}`);
  lines.push(`statuses: ${config.statuses.join(', ')}`);
  lines.push(`tags: ${config.tags.canonical.join(', ')}`);

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
  if (!Object.hasOwn(deps.vaultConfig.scopes, input.scope)) {
    const valid = Object.keys(deps.vaultConfig.scopes).sort().join(', ');
    return textError({
      code: 'UNKNOWN_SCOPE',
      message: `unknown scope "${input.scope}"; valid scopes: ${valid}`
    });
  }
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
