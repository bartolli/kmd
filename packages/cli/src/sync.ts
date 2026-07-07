import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalVaultRoot, openDatabase, resolveIndexPath, setMeta } from '@llm-wiki/db/database';
import { z } from 'zod';
import { loadVaultConfig } from './config.js';
import { type ParsedFrontmatter, parseFrontmatter } from './frontmatter.js';

const EnvSchema = z.object({
  WIKI_VAULT: z.string().min(1)
});

// Scan only the three content domains. raw/, templates/, .obsidian/, .git/
// are intentionally excluded by the design.
export const SCAN_DOMAINS = ['projects', 'research', 'notes'] as const;

// [[target]], [[target|display]], [[target#heading]], [[target^block]]
const WIKILINK_RE = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g;

interface Frontmatter {
  title?: string;
  kind?: string;
  status?: string;
  summary?: string;
  tags?: string[];
  updated?: string | Date;
}

// Frontmatter keys that already map to first-class indexed columns. Anything
// outside this set flows into the `meta` JSONB column verbatim, so future
// vocabulary extensions (e.g. story.triage_state, story.category) become
// queryable without further schema changes.
const INDEXED_FRONTMATTER_KEYS = new Set<string>([
  'title',
  'kind',
  'status',
  'summary',
  'tags',
  'updated',
  'scope',
  'topic'
]);

interface WikiLink {
  target: string;
  text: string | null;
}

interface PageFields {
  path: string;
  title: string;
  kind: string;
  scope: string | null;
  topic: string | null;
  status: string;
  summary: string | null;
  tags: string[] | null;
  updated: string | null;
  body: string;
  hash: string;
  meta: Record<string, unknown> | null;
}

type SyncResult = 'changed' | 'unchanged' | 'skipped';

function loadEnv(): { WIKI_VAULT: string } {
  const parsed = EnvSchema.safeParse({
    WIKI_VAULT: process.env.WIKI_VAULT
  });
  if (!parsed.success) {
    console.error('invalid env:');
    console.error(parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}

export async function walkMarkdown(root: string, domain: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    // null when the domain dir doesn't exist yet — fine, nothing to walk.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        await recurse(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(join(dir, entry.name));
      }
    }
  }
  await recurse(join(root, domain));
  return out;
}

export function toRelativePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function extractWikilinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKILINK_RE)) {
    const rawTarget = match[1]?.trim() ?? '';
    if (!rawTarget) continue;
    // Treat any existing extension as authoritative (handles embeds of
    // `.base`, `.png`, `.pdf`, etc.); only append `.md` when the target
    // is bare.
    const hasExt = /\.[a-zA-Z0-9]+$/.test(rawTarget);
    const target = hasExt ? rawTarget : `${rawTarget}.md`;
    const text = match[2]?.trim() ?? null;
    const key = `${target}|${text ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ target, text });
  }
  return links;
}

/**
 * Path is authoritative for scope/topic. Frontmatter may also carry these
 * (for human readability) but sync trusts the filesystem.
 *
 *   projects/{scope}/...   → scope = first segment
 *   research/{topic}/...   → topic = first segment
 *   notes/...              → both null
 */
export function deriveLocation(relPath: string): { scope: string | null; topic: string | null } {
  const segments = relPath.split('/');
  const domain = segments[0];
  if (domain === 'projects' && segments.length >= 2 && segments[1]) {
    return { scope: segments[1], topic: null };
  }
  if (domain === 'research' && segments.length >= 2 && segments[1]) {
    return { scope: null, topic: segments[1] };
  }
  return { scope: null, topic: null };
}

/**
 * Build the page row from frontmatter + path. Returns `null` to signal
 * "skip this file" (intentionally not indexed).
 *
 * Skip rules:
 *  - No `title` in frontmatter → narrative-only page (e.g., primer.md).
 *  - No `kind` AND not under notes/ → authoring incomplete; warn.
 *
 * Notes are the one place where `kind` is implied by location.
 */
export function buildPageFields(
  relPath: string,
  raw: string,
  parsed: ParsedFrontmatter,
  knownScopes: ReadonlySet<string>
): PageFields | null {
  const fm = parsed.data as Frontmatter;
  if (!fm.title) {
    return null;
  }

  let kind = fm.kind;
  if (!kind) {
    if (relPath.startsWith('notes/')) {
      kind = 'note';
    } else {
      console.warn(`  skip: ${relPath} — has title but missing kind`);
      return null;
    }
  }

  const { scope, topic } = deriveLocation(relPath);
  if (scope !== null && !knownScopes.has(scope)) {
    throw new Error(
      `unknown scope "${scope}" for ${relPath} — add it to vault.yaml or remove the page`
    );
  }
  const updated =
    fm.updated instanceof Date
      ? fm.updated.toISOString().slice(0, 10)
      : typeof fm.updated === 'string'
        ? fm.updated.slice(0, 10)
        : null;

  const metaEntries = Object.entries(parsed.data as Record<string, unknown>).filter(
    ([k]) => !INDEXED_FRONTMATTER_KEYS.has(k)
  );
  const meta = metaEntries.length > 0 ? Object.fromEntries(metaEntries) : null;

  return {
    path: relPath,
    title: fm.title,
    kind,
    scope,
    topic,
    status: fm.status ?? (kind === 'note' ? 'active' : 'draft'),
    summary: fm.summary ?? null,
    tags: Array.isArray(fm.tags) ? fm.tags : null,
    updated,
    body: parsed.content,
    hash: sha256(raw),
    meta
  };
}

export function syncPage(db: DatabaseSync, fields: PageFields): SyncResult {
  const existing = db.prepare('SELECT content_hash FROM pages WHERE path = ?').get(fields.path) as
    | { content_hash: string | null }
    | undefined;
  if (existing?.content_hash === fields.hash) {
    return 'unchanged';
  }

  const upsert = db.prepare(
    `INSERT INTO pages (path, title, kind, scope, topic, status, summary, tags, updated, body, content_hash, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET
       title        = EXCLUDED.title,
       kind         = EXCLUDED.kind,
       scope        = EXCLUDED.scope,
       topic        = EXCLUDED.topic,
       status       = EXCLUDED.status,
       summary      = EXCLUDED.summary,
       tags         = EXCLUDED.tags,
       updated      = EXCLUDED.updated,
       body         = EXCLUDED.body,
       content_hash = EXCLUDED.content_hash,
       meta         = EXCLUDED.meta`
  );

  upsert.run(
    fields.path,
    fields.title,
    fields.kind,
    fields.scope,
    fields.topic,
    fields.status,
    fields.summary,
    fields.tags ? JSON.stringify(fields.tags) : null,
    fields.updated,
    fields.body,
    fields.hash,
    fields.meta ? JSON.stringify(fields.meta) : null
  );

  db.prepare('DELETE FROM links WHERE source_path = ?').run(fields.path);
  const insertLink = db.prepare(
    `INSERT INTO links (source_path, target_path, link_text)
     VALUES (?, ?, ?)
     ON CONFLICT (source_path, target_path) DO NOTHING`
  );
  for (const link of extractWikilinks(fields.body)) {
    insertLink.run(fields.path, link.target, link.text);
  }

  return 'changed';
}

export async function runSync(): Promise<void> {
  const env = loadEnv();
  const dbPath = resolveIndexPath(env.WIKI_VAULT);
  console.log(`sync: ${env.WIKI_VAULT} → ${dbPath}`);

  const vaultConfig = await loadVaultConfig(env.WIKI_VAULT);
  const scopes = new Set(Object.keys(vaultConfig.scopes));

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);

  try {
    const files: string[] = [];
    for (const domain of SCAN_DOMAINS) {
      files.push(...(await walkMarkdown(env.WIKI_VAULT, domain)));
    }

    const indexedPaths: string[] = [];
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const file of files) {
      const path = toRelativePath(env.WIKI_VAULT, file);
      const raw = await readFile(file, 'utf8');
      const parsed = parseFrontmatter(raw);
      const fields = buildPageFields(path, raw, parsed, scopes);
      if (!fields) {
        skipped++;
        continue;
      }

      const result = syncPage(db, fields);
      if (result === 'changed') {
        changed++;
      } else {
        unchanged++;
      }
      indexedPaths.push(path);
    }

    let pagesDeleted = 0;
    let linksDeleted = 0;
    if (indexedPaths.length > 0) {
      const placeholders = indexedPaths.map(() => '?').join(', ');
      const pageResult = db
        .prepare(`DELETE FROM pages WHERE path NOT IN (${placeholders})`)
        .run(...indexedPaths);
      pagesDeleted = Number(pageResult.changes);
      const linkResult = db
        .prepare('DELETE FROM links WHERE source_path NOT IN (SELECT path FROM pages)')
        .run();
      linksDeleted = Number(linkResult.changes);
    } else {
      console.warn('no indexable pages found; skipping orphan deletion (safety)');
    }

    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");

    setMeta(db, 'vault_root', canonicalVaultRoot(env.WIKI_VAULT));
    setMeta(db, 'last_synced', new Date().toISOString());

    console.log(
      `done: ${changed} changed, ${unchanged} unchanged, ${skipped} skipped, ${pagesDeleted} pages deleted, ${linksDeleted} link orphans cleared`
    );
  } finally {
    db.close();
  }
}
