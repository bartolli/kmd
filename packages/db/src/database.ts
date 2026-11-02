import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Set by a transactional sync at commit; any page or link write clears it. */
export const INDEX_TRUSTED_KEY = 'index_trusted';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    kind         TEXT NOT NULL,
    scope        TEXT,
    topic        TEXT,
    status       TEXT NOT NULL DEFAULT 'draft',
    summary      TEXT,
    tags         TEXT,
    updated      TEXT,
    body         TEXT,
    content_hash TEXT,
    meta         TEXT
);

CREATE INDEX IF NOT EXISTS pages_scope_kind ON pages(scope, kind, status);
CREATE INDEX IF NOT EXISTS pages_topic_kind ON pages(topic, kind, status);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title, summary, body,
    content='pages',
    content_rowid='id'
);

CREATE TABLE IF NOT EXISTS links (
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    link_text   TEXT,
    PRIMARY KEY (source_path, target_path)
);

CREATE INDEX IF NOT EXISTS links_source ON links(source_path);
CREATE INDEX IF NOT EXISTS links_target ON links(target_path);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT DEFAULT (datetime('now')),
    scope     TEXT,
    operation TEXT NOT NULL,
    path      TEXT,
    note      TEXT
);

CREATE INDEX IF NOT EXISTS events_scope_ts ON events(scope, ts DESC);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Any write to the derived tables clears the stamp a transactional sync sets at
-- commit. Triggers live in the file, so an engine that predates the stamp still
-- clears it, and the no-change check never vouches for rows it wrote.
CREATE TRIGGER IF NOT EXISTS pages_insert_untrusts AFTER INSERT ON pages
BEGIN DELETE FROM meta WHERE key = '${INDEX_TRUSTED_KEY}'; END;
CREATE TRIGGER IF NOT EXISTS pages_update_untrusts AFTER UPDATE ON pages
BEGIN DELETE FROM meta WHERE key = '${INDEX_TRUSTED_KEY}'; END;
CREATE TRIGGER IF NOT EXISTS pages_delete_untrusts AFTER DELETE ON pages
BEGIN DELETE FROM meta WHERE key = '${INDEX_TRUSTED_KEY}'; END;
CREATE TRIGGER IF NOT EXISTS links_insert_untrusts AFTER INSERT ON links
BEGIN DELETE FROM meta WHERE key = '${INDEX_TRUSTED_KEY}'; END;
CREATE TRIGGER IF NOT EXISTS links_update_untrusts AFTER UPDATE ON links
BEGIN DELETE FROM meta WHERE key = '${INDEX_TRUSTED_KEY}'; END;
CREATE TRIGGER IF NOT EXISTS links_delete_untrusts AFTER DELETE ON links
BEGIN DELETE FROM meta WHERE key = '${INDEX_TRUSTED_KEY}'; END;
`;

// Bounds one lock wait, not a whole hook. Well under the shortest harness hook
// timeout, so exhausted contention surfaces as a sync warning, not a killed hook.
const BUSY_TIMEOUT_MS = 10_000;
const SQLITE_BUSY = 5;
const WAL_RETRY_DELAY_MS = 20;

export function isBusy(err: unknown): boolean {
  // node:sqlite reports extended codes; the low byte is the primary code.
  const errcode = (err as { errcode?: number }).errcode ?? 0;
  return (errcode & 0xff) === SQLITE_BUSY;
}

// A journal-mode switch returns SQLITE_BUSY without consulting the busy
// handler, so concurrent openers of a fresh index retry it here.
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAL_RETRY_DELAY_MS);
    }
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  enableWal(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Root of kmd's per-user state tree (default `~/.kmd`); `$KMD_HOME` relocates it. */
export function kmdHome(): string {
  return process.env.KMD_HOME ?? join(homedir(), '.kmd');
}

/**
 * Directory holding all per-vault indexes: `$KMD_HOME/db/{vault-key}/index.db`
 * (default `~/.kmd`). One directory per vault keyed by resolved path, so two
 * vaults can never clobber each other's index and a moved/re-pointed vault
 * gets a fresh one.
 */
export function indexRootDir(): string {
  return join(kmdHome(), 'db');
}

/**
 * Resolved (symlink-free, absolute) vault root — the canonical identity a
 * vault is keyed by. Falls back to plain resolution when the path does not
 * exist yet.
 */
export function canonicalVaultRoot(vaultRoot: string): string {
  try {
    return realpathSync(vaultRoot);
  } catch {
    return resolve(vaultRoot);
  }
}

/** `{basename}-{8-hex}` — human-scannable, collision-safe per resolved path. */
export function vaultKey(vaultRoot: string): string {
  const canonical = canonicalVaultRoot(vaultRoot);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return `${basename(canonical)}-${hash}`;
}

/**
 * True when `dir` is the global `.kmd` home itself. The home is never a
 * project tier's `.kmd`: a vault directly under HOME would otherwise index at
 * `~/.kmd/db/index.db` (shared by every such vault, deleted whole by
 * `kmd db reset`), and the tier walk would read `~/.kmd/config.yaml` with the
 * project schema. Both sides canonical — the walk realpaths its levels.
 */
export function isKmdHome(dir: string): boolean {
  return canonicalVaultRoot(dir) === canonicalVaultRoot(kmdHome());
}

/** The vault's tier `.kmd/` home (vault root, then its parent), or null. */
function tierKmdDir(canonical: string): string | null {
  for (const stateHome of [join(canonical, '.kmd'), join(dirname(canonical), '.kmd')]) {
    if (existsSync(stateHome) && !isKmdHome(stateHome)) return stateHome;
  }
  return null;
}

/**
 * Absolute path of the vault's index database file. A vault beside a `.kmd/`
 * directory (at the vault root, then its parent) homes the index there —
 * project-tier indexes live and die with their repos. Otherwise the global
 * keyed home, so two vaults can never clobber each other.
 */
export function resolveIndexPath(vaultRoot: string): string {
  const canonical = canonicalVaultRoot(vaultRoot);
  const tier = tierKmdDir(canonical);
  if (tier !== null) return join(tier, 'db', 'index.db');
  return join(indexRootDir(), vaultKey(canonical), 'index.db');
}

/**
 * Hook dedup-state directory for a vault: the tier `.kmd/state/hook` when the
 * vault is tier-homed, else the global `$KMD_HOME/state/hook`. Deliberately
 * outside `db/` at both homes so `kmd db reset` keeps it.
 */
export function resolveStateDir(vaultRoot: string): string {
  const canonical = canonicalVaultRoot(vaultRoot);
  const tier = tierKmdDir(canonical);
  if (tier !== null) return join(tier, 'state', 'hook');
  return join(kmdHome(), 'state', 'hook');
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
