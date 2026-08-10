import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getMeta,
  indexRootDir,
  openDatabase,
  resolveIndexPath,
  setMeta,
  vaultKey
} from './database.js';

function insertPage(
  db: ReturnType<typeof openDatabase>,
  overrides: Partial<{
    path: string;
    title: string;
    kind: string;
    scope: string;
    status: string;
    summary: string;
    body: string;
    content_hash: string;
    tags: string;
  }> = {}
) {
  const p = {
    path: 'projects/sotto/spec/spec-x.md',
    title: 'Test Spec',
    kind: 'spec',
    scope: 'sotto',
    status: 'active',
    summary: 'A test specification',
    body: 'This page describes the Postgres migration to SQLite',
    content_hash: 'abc123',
    tags: null,
    ...overrides
  };
  db.prepare(
    `INSERT INTO pages (path, title, kind, scope, status, summary, body, content_hash, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(p.path, p.title, p.kind, p.scope, p.status, p.summary, p.body, p.content_hash, p.tags);
}

describe('openDatabase', () => {
  it('creates tables and supports FTS5 round-trip: insert a page, find it by search', () => {
    const db = openDatabase(':memory:');

    insertPage(db);
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");

    const results = db
      .prepare(
        `SELECT p.path, p.title, p.kind, bm25(pages_fts) AS score
         FROM pages_fts
         JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ?
         ORDER BY bm25(pages_fts)
         LIMIT 5`
      )
      .all('postgres') as Array<{ path: string; title: string; kind: string; score: number }>;

    expect(results).toHaveLength(1);
    const first = results[0];
    expect(first).toBeDefined();
    expect(first?.path).toBe('projects/sotto/spec/spec-x.md');
    expect(first?.title).toBe('Test Spec');
    expect(first?.score).toBeLessThan(0);

    db.close();
  });
});

describe('per-vault index layout', () => {
  it('keys the index by resolved vault path under ~/.kmd/db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kmd-vault-'));
    try {
      const path = resolveIndexPath(dir);

      expect(path.startsWith(join(homedir(), '.kmd', 'db'))).toBe(true);
      expect(path.endsWith('index.db')).toBe(true);
      expect(vaultKey(dir)).toMatch(/^kmd-vault-.+-[0-9a-f]{8}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two vaults get distinct index paths; the same vault is stable', () => {
    const a = mkdtempSync(join(tmpdir(), 'kmd-vault-a-'));
    const b = mkdtempSync(join(tmpdir(), 'kmd-vault-b-'));
    try {
      expect(resolveIndexPath(a)).not.toBe(resolveIndexPath(b));
      expect(resolveIndexPath(a)).toBe(resolveIndexPath(a));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('a symlink to a vault maps to the same index as the real path', () => {
    const real = mkdtempSync(join(tmpdir(), 'kmd-vault-real-'));
    const link = join(tmpdir(), `kmd-vault-link-${Date.now()}`);
    try {
      symlinkSync(realpathSync(real), link);

      expect(resolveIndexPath(link)).toBe(resolveIndexPath(real));
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('meta round-trips and upserts', () => {
    const db = openDatabase(':memory:');

    expect(getMeta(db, 'vault_root')).toBeNull();
    setMeta(db, 'vault_root', '/vaults/a');
    setMeta(db, 'vault_root', '/vaults/b');

    expect(getMeta(db, 'vault_root')).toBe('/vaults/b');
    db.close();
  });

  it('a vault beside a .kmd directory homes its index there', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kmd-tier-repo-'));
    try {
      const vault = join(repo, 'vault');
      mkdirSync(vault, { recursive: true });
      mkdirSync(join(repo, '.kmd'));

      expect(resolveIndexPath(vault)).toBe(join(realpathSync(repo), '.kmd', 'db', 'index.db'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a root-layout vault with its own .kmd homes the index inside it', () => {
    const vault = mkdtempSync(join(tmpdir(), 'kmd-tier-rootvault-'));
    try {
      mkdirSync(join(vault, '.kmd'));

      expect(resolveIndexPath(vault)).toBe(join(realpathSync(vault), '.kmd', 'db', 'index.db'));
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('a vault with no .kmd sibling keeps the global keyed home', () => {
    const vault = mkdtempSync(join(tmpdir(), 'kmd-tier-plain-'));
    try {
      expect(resolveIndexPath(vault)).toBe(join(indexRootDir(), vaultKey(vault), 'index.db'));
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
