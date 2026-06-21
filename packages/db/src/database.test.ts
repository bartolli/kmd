import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';

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
