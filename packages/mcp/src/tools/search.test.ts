import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@llm-wiki/db/database';
import { describe, expect, it } from 'vitest';
import { search } from './search.js';

function seedPages(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO pages (path, title, kind, scope, status, summary, body, content_hash, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    'projects/sotto/spec/spec-api.md',
    'API Specification',
    'spec',
    'sotto',
    'active',
    'REST API contract',
    'The API uses JSON over HTTPS with OAuth tokens',
    'h1',
    '["mcp","api"]'
  );
  insert.run(
    'projects/sotto/adr/adr-auth.md',
    'Authentication Decision',
    'adr',
    'sotto',
    'active',
    'OAuth2 for auth',
    'We chose OAuth2 with PKCE for authentication flow',
    'h2',
    '["auth"]'
  );
  insert.run(
    'projects/codanna/spec/spec-sync.md',
    'Sync Protocol',
    'spec',
    'codanna',
    'active',
    'Sync specification',
    'The sync protocol uses WebSocket for real-time updates',
    'h3',
    '["sync"]'
  );
  db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
}

describe('search against SQLite', () => {
  it('returns FTS5-ranked results for a query', () => {
    const db = openDatabase(':memory:');
    seedPages(db);

    const result = search({ db }, { query: 'authentication PKCE', limit: 5 });

    expect(result.results.length).toBeGreaterThan(0);
    const first = result.results[0];
    expect(first).toBeDefined();
    expect(first?.path).toBe('projects/sotto/adr/adr-auth.md');
    expect(first?.score).toBeLessThan(0);

    db.close();
  });

  it('filters by scope', () => {
    const db = openDatabase(':memory:');
    seedPages(db);

    const result = search({ db }, { query: 'specification protocol', scope: 'codanna', limit: 5 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.scope).toBe('codanna');

    db.close();
  });

  it('filters by kind', () => {
    const db = openDatabase(':memory:');
    seedPages(db);

    const result = search({ db }, { query: 'OAuth API', kind: 'adr', limit: 5 });

    for (const r of result.results) {
      expect(r.kind).toBe('adr');
    }

    db.close();
  });

  it('handles special characters in queries without throwing', () => {
    const db = openDatabase(':memory:');
    seedPages(db);

    expect(() => search({ db }, { query: 'real-time updates', limit: 5 })).not.toThrow();
    expect(() => search({ db }, { query: '"exact phrase"', limit: 5 })).not.toThrow();
    expect(() => search({ db }, { query: 'foo AND bar', limit: 5 })).not.toThrow();
    expect(() => search({ db }, { query: 'CLAUDE.md separate pedagogy', limit: 5 })).not.toThrow();
    expect(() =>
      search({ db }, { query: 'path/to/file.ts @scope +required', limit: 5 })
    ).not.toThrow();

    db.close();
  });
});
