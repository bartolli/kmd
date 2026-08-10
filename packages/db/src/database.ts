import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
`;

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
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

/** The vault's tier `.kmd/` home (vault root, then its parent), or null. */
function tierKmdDir(canonical: string): string | null {
  for (const stateHome of [join(canonical, '.kmd'), join(dirname(canonical), '.kmd')]) {
    if (existsSync(stateHome)) return stateHome;
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
