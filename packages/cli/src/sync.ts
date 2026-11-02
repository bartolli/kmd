import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalVaultRoot,
  getMeta,
  INDEX_TRUSTED_KEY,
  isBusy,
  openDatabase,
  resolveIndexPath,
  setMeta
} from '@llm-wiki/db/database';
import { loadVaultConfig, type VaultConfig } from '@llm-wiki/db/vault-config';
import { z } from 'zod';
import { type ParsedFrontmatter, parseFrontmatter } from './frontmatter.js';
import { refreshSchemaFile } from './init.js';
import type { Finding } from './validate.js';

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

/** One read of the vault, so what validate judges is what sync indexes. */
export interface VaultSnapshot {
  root: string;
  config: VaultConfig;
  /** Every page in the vault; references resolve against this universe. */
  allPaths: string[];
  /** The content-domain pages, in `SCAN_DOMAINS` order. */
  pages: { path: string; raw: string }[];
}

export async function readVaultSnapshot(root: string): Promise<VaultSnapshot> {
  const config = await loadVaultConfig(root);
  const allPaths = (await walkMarkdown(root, '.')).map((abs) => toRelativePath(root, abs));
  const pages: VaultSnapshot['pages'] = [];
  for (const domain of SCAN_DOMAINS) {
    for (const path of allPaths) {
      if (path.startsWith(`${domain}/`)) {
        pages.push({ path, raw: await readFile(join(root, path), 'utf8') });
      }
    }
  }
  return { root, config, allPaths, pages };
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
/** A page whose parent chain carries a `notes/` folder — the root domain or a
 * scope's own `projects/{scope}/notes/`. Kind is implied by location there. */
export function isNotesPath(relPath: string): boolean {
  return relPath.split('/').slice(0, -1).includes('notes');
}

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
 *  - No `kind` AND not under a notes/ folder → authoring incomplete; warn.
 *
 * Notes are the one place where `kind` is implied by location — the root
 * domain or a scope's own notes/ folder.
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
    if (isNotesPath(relPath)) {
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
      ? fm.updated.toISOString()
      : typeof fm.updated === 'string'
        ? fm.updated
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

/** `rewrite` skips the hash shortcut: a matching hash vouches for a row, never for its links. */
export function syncPage(db: DatabaseSync, fields: PageFields, rewrite = false): SyncResult {
  const existing = db.prepare('SELECT content_hash FROM pages WHERE path = ?').get(fields.path) as
    | { content_hash: string | null }
    | undefined;
  if (!rewrite && existing?.content_hash === fields.hash) {
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

/** Sync-side finding, shaped like validate's so the hook codecs render both. */
export interface SyncWarning {
  path: string;
  rule: 'updated-not-advanced';
  severity: 'warning';
  message: string;
}

export interface SyncStats {
  changed: number;
  unchanged: number;
  skipped: number;
  pagesDeleted: number;
  linksDeleted: number;
  noPages: boolean;
  warnings: SyncWarning[];
  /** The findings that held this sync; empty when it was not held. */
  heldBy: Finding[];
}

export interface SyncOptions {
  /** Judges the snapshot about to be indexed, under the writer lock. */
  gate?: (snapshot: VaultSnapshot) => Promise<Finding[]>;
  /** A read the caller already holds: when the index matches it, nothing queues. */
  observed?: VaultSnapshot;
}

function noWrites(heldBy: Finding[] = []): SyncStats {
  return {
    changed: 0,
    unchanged: 0,
    skipped: 0,
    pagesDeleted: 0,
    linksDeleted: 0,
    noPages: false,
    warnings: [],
    heldBy
  };
}

function wouldIndex(path: string, raw: string, scopes: ReadonlySet<string>): boolean {
  try {
    return buildPageFields(path, raw, parseFrontmatter(raw), scopes) !== null;
  } catch {
    return true;
  }
}

/**
 * Whether a sync of this snapshot would change nothing. Any doubt reads as a
 * change: an unindexed page that could index, a row with no file, a hash that
 * moved, or an index some write touched after the last transactional commit.
 */
function indexMatches(db: DatabaseSync, snapshot: VaultSnapshot): boolean {
  if (getMeta(db, INDEX_TRUSTED_KEY) === null) return false;
  const rows = db.prepare('SELECT path, content_hash FROM pages').all() as {
    path: string;
    content_hash: string | null;
  }[];
  const indexed = new Map(rows.map((row) => [row.path, row.content_hash]));
  const scopes = new Set(Object.keys(snapshot.config.scopes));
  for (const { path, raw } of snapshot.pages) {
    if (!indexed.has(path)) {
      if (wouldIndex(path, raw, scopes)) return false;
    } else if (indexed.get(path) !== sha256(raw)) {
      return false;
    }
    indexed.delete(path);
  }
  return indexed.size === 0;
}

/** Advances `synced` without waiting: a held lock is a sync that stamps it at commit. */
function stampVerified(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 0');
  try {
    setMeta(db, 'last_synced', new Date().toISOString());
  } catch (err) {
    if (!isBusy(err)) throw err;
  }
}

/**
 * The clock check that makes `updated` trustworthy for the gates: a page
 * whose content moved while its clock stayed put was edited without the
 * frontmatter bump. Read before the upsert overwrites the stored row.
 */
export function clockNotAdvanced(db: DatabaseSync, fields: PageFields): SyncWarning | null {
  const existing = db
    .prepare('SELECT content_hash, updated FROM pages WHERE path = ?')
    .get(fields.path) as { content_hash: string | null; updated: string | null } | undefined;
  if (!existing || existing.content_hash === fields.hash) return null;
  if (fields.updated === null || existing.updated !== fields.updated) return null;
  return {
    path: fields.path,
    rule: 'updated-not-advanced',
    severity: 'warning',
    message: `content changed but "updated" is still ${fields.updated} — set it from \`date -u +%Y-%m-%dT%H:%M:%SZ\``
  };
}

/**
 * The sync pipeline without operator output — the seam the posttool hook
 * calls in-process, where stdout belongs to the harness protocol.
 */
export async function syncVault(vaultRoot: string, options: SyncOptions = {}): Promise<SyncStats> {
  const stats = await indexVault(vaultRoot, options);
  // Derived artifact like the index: refreshed so engine upgrades surface as a
  // git diff, not silent IDE/runtime disagreement. stderr keeps every hook
  // codec's stdout clean.
  if (stats.heldBy.length === 0 && (await refreshSchemaFile(vaultRoot))) {
    console.error('sync: vault.schema.json refreshed to the running engine');
  }
  return stats;
}

async function indexVault(vaultRoot: string, { gate, observed }: SyncOptions): Promise<SyncStats> {
  const dbPath = resolveIndexPath(vaultRoot);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);

  try {
    if (observed) {
      // One read transaction, so the stamp and the rows come from the same commit.
      db.exec('BEGIN');
      const matches = indexMatches(db, observed);
      db.exec('COMMIT');
      if (matches) {
        stampVerified(db);
        return noWrites();
      }
    }

    // The lock spans the read: a sync that read the vault before a concurrent
    // sync's commit would otherwise overwrite or sweep that newer result, and
    // content validated before the wait could change during it. An uncommitted
    // return or failure rolls back at close, keeping the prior index.
    db.exec('BEGIN IMMEDIATE');
    const snapshot = await readVaultSnapshot(vaultRoot);
    if (observed && indexMatches(db, snapshot)) return noWrites();
    const heldBy = (await gate?.(snapshot)) ?? [];
    if (heldBy.length > 0) return noWrites(heldBy);
    // Read before the first write clears it. Without the stamp, rows and links
    // may come from an interrupted writer, so every page is rewritten.
    const rewrite = getMeta(db, INDEX_TRUSTED_KEY) === null;

    const scopes = new Set(Object.keys(snapshot.config.scopes));
    const indexedPaths: string[] = [];
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    const warnings: SyncWarning[] = [];

    for (const { path, raw } of snapshot.pages) {
      const parsed = parseFrontmatter(raw);
      const fields = buildPageFields(path, raw, parsed, scopes);
      if (!fields) {
        skipped++;
        continue;
      }

      const warning = clockNotAdvanced(db, fields);
      if (warning) warnings.push(warning);
      const result = syncPage(db, fields, rewrite);
      if (result === 'changed') {
        changed++;
      } else {
        unchanged++;
      }
      indexedPaths.push(path);
    }

    // The sweep runs even when the vault reads empty: loadVaultConfig already
    // failed loud on a mis-mounted root, so zero pages means a legitimately
    // emptied vault — retaining orphans would serve stale search results.
    const placeholders = indexedPaths.map(() => '?').join(', ');
    const pageResult =
      indexedPaths.length > 0
        ? db.prepare(`DELETE FROM pages WHERE path NOT IN (${placeholders})`).run(...indexedPaths)
        : db.prepare('DELETE FROM pages').run();
    const pagesDeleted = Number(pageResult.changes);
    const linkResult = db
      .prepare('DELETE FROM links WHERE source_path NOT IN (SELECT path FROM pages)')
      .run();
    const linksDeleted = Number(linkResult.changes);

    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");

    setMeta(db, 'vault_root', canonicalVaultRoot(vaultRoot));
    setMeta(db, INDEX_TRUSTED_KEY, new Date().toISOString());
    setMeta(db, 'last_synced', new Date().toISOString());
    db.exec('COMMIT');

    return {
      changed,
      unchanged,
      skipped,
      pagesDeleted,
      linksDeleted,
      noPages: indexedPaths.length === 0,
      warnings,
      heldBy: []
    };
  } finally {
    db.close();
  }
}

export async function runSync(gate: NonNullable<SyncOptions['gate']>): Promise<Finding[]> {
  const env = loadEnv();
  console.log(`sync: ${env.WIKI_VAULT} → ${resolveIndexPath(env.WIKI_VAULT)}`);
  const stats = await syncVault(env.WIKI_VAULT, { gate });
  if (stats.heldBy.length > 0) return stats.heldBy;
  if (stats.noPages) {
    console.warn('no indexable pages found; index swept empty');
  }
  for (const w of stats.warnings) {
    console.error(`${w.severity}: ${w.path} [${w.rule}] ${w.message}`);
  }
  console.log(
    `done: ${stats.changed} changed, ${stats.unchanged} unchanged, ${stats.skipped} skipped, ${stats.pagesDeleted} pages deleted, ${stats.linksDeleted} link orphans cleared`
  );
  return [];
}
