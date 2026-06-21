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
`;

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
