import { openDatabase } from '@llm-wiki/db/database';
import { describe, expect, it } from 'vitest';
import { type ParsedFrontmatter, parseFrontmatter } from './frontmatter.js';
import { buildPageFields, syncPage } from './sync.js';

const known = new Set(['sotto', 'codanna']);

function parsePage(frontmatter: string): { raw: string; parsed: ParsedFrontmatter } {
  const raw = `---\n${frontmatter}\n---\nbody text\n`;
  return { raw, parsed: parseFrontmatter(raw) };
}

describe('buildPageFields scope authority', () => {
  it('indexes a page under a configured scope', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec');

    const fields = buildPageFields('projects/sotto/spec/spec-x.md', raw, parsed, known);

    expect(fields?.scope).toBe('sotto');
  });

  it('throws on a page under an unconfigured scope', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec');

    expect(() => buildPageFields('projects/ghost/spec/spec-x.md', raw, parsed, known)).toThrow(
      /ghost/
    );
  });

  it('normalizes a string `updated` (the yaml parser keeps dates as strings) to YYYY-MM-DD', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec\nupdated: 2026-04-28');

    const fields = buildPageFields('projects/sotto/spec/spec-x.md', raw, parsed, known);

    expect(fields?.updated).toBe('2026-04-28');
  });
});

describe('syncPage against SQLite', () => {
  function makeFields(
    overrides: Partial<{
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
    }> = {}
  ) {
    return {
      path: 'projects/sotto/spec/spec-x.md',
      title: 'Test Spec',
      kind: 'spec',
      scope: 'sotto' as string | null,
      topic: null as string | null,
      status: 'active',
      summary: 'A test specification',
      tags: ['mcp', 'sync'] as string[] | null,
      updated: '2026-06-21',
      body: 'This page describes the migration',
      hash: 'abc123',
      meta: null as Record<string, unknown> | null,
      ...overrides
    };
  }

  it('inserts a new page and returns changed', () => {
    const db = openDatabase(':memory:');
    const result = syncPage(db, makeFields());

    expect(result).toBe('changed');

    const row = db
      .prepare('SELECT title, kind, scope FROM pages WHERE path = ?')
      .get('projects/sotto/spec/spec-x.md') as
      | { title: string; kind: string; scope: string }
      | undefined;
    expect(row?.title).toBe('Test Spec');
    expect(row?.kind).toBe('spec');
    expect(row?.scope).toBe('sotto');

    db.close();
  });

  it('skips a page with an unchanged content hash', () => {
    const db = openDatabase(':memory:');
    syncPage(db, makeFields());

    const result = syncPage(db, makeFields());
    expect(result).toBe('unchanged');

    db.close();
  });

  it('updates a page when the content hash changes', () => {
    const db = openDatabase(':memory:');
    syncPage(db, makeFields());

    const result = syncPage(db, makeFields({ title: 'Updated Spec', hash: 'def456' }));
    expect(result).toBe('changed');

    const row = db
      .prepare('SELECT title FROM pages WHERE path = ?')
      .get('projects/sotto/spec/spec-x.md') as { title: string } | undefined;
    expect(row?.title).toBe('Updated Spec');

    db.close();
  });

  it('stores tags as JSON and meta as JSON', () => {
    const db = openDatabase(':memory:');
    syncPage(
      db,
      makeFields({
        tags: ['mcp', 'sync'],
        meta: { triage_state: 'ready-for-agent', category: 'enhancement' }
      })
    );

    const row = db
      .prepare('SELECT tags, meta FROM pages WHERE path = ?')
      .get('projects/sotto/spec/spec-x.md') as { tags: string; meta: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row?.tags ?? '')).toEqual(['mcp', 'sync']);
    expect(JSON.parse(row?.meta ?? '')).toEqual({
      triage_state: 'ready-for-agent',
      category: 'enhancement'
    });

    db.close();
  });
});
