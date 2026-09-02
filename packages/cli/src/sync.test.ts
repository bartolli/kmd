import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, resolveIndexPath } from '@llm-wiki/db/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ParsedFrontmatter, parseFrontmatter } from './frontmatter.js';
import { buildPageFields, syncPage, syncVault } from './sync.js';

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

  it('keeps the intent provenance and outcome fields in meta, scope from the path', () => {
    const { raw, parsed } = parsePage(
      'title: X\nkind: intent\nstatus: archived\norigin: retro\nsightings: 2\npromoted_to: story-4-x\ndismissed: ""'
    );

    const fields = buildPageFields('projects/sotto/intent/intent-x.md', raw, parsed, known);

    expect(fields?.scope).toBe('sotto');
    expect(fields?.kind).toBe('intent');
    expect(fields?.meta).toMatchObject({
      origin: 'retro',
      sightings: 2,
      promoted_to: 'story-4-x',
      dismissed: ''
    });
  });

  it("infers kind: note for a kind-less page under a scope's notes/ folder", () => {
    const { raw, parsed } = parsePage('title: Retro\nupdated: "2026-09-02T14:00:00Z"');

    const fields = buildPageFields('projects/sotto/notes/retro-2026-09-02.md', raw, parsed, known);

    expect(fields?.kind).toBe('note');
    expect(fields?.scope).toBe('sotto');
  });

  it('throws on a page under an unconfigured scope', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec');

    expect(() => buildPageFields('projects/ghost/spec/spec-x.md', raw, parsed, known)).toThrow(
      /ghost/
    );
  });

  it('keeps `updated` as written — a date stays a date, a UTC timestamp keeps its time', () => {
    const day = parsePage('title: X\nkind: spec\nupdated: 2026-04-28');
    const stamp = parsePage('title: X\nkind: spec\nupdated: "2026-09-02T14:30:00Z"');

    expect(
      buildPageFields('projects/sotto/spec/spec-x.md', day.raw, day.parsed, known)?.updated
    ).toBe('2026-04-28');
    expect(
      buildPageFields('projects/sotto/spec/spec-x.md', stamp.raw, stamp.parsed, known)?.updated
    ).toBe('2026-09-02T14:30:00Z');
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

describe('syncVault orphan sweep', () => {
  let vaultRoot: string;
  let kmdHomeBefore: string | undefined;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'kmd-sync-vault-'));
    kmdHomeBefore = process.env.KMD_HOME;
    process.env.KMD_HOME = mkdtempSync(join(tmpdir(), 'kmd-sync-home-'));
    writeFileSync(
      join(vaultRoot, 'vault.yaml'),
      [
        'scopes: {}',
        'kinds: [note]',
        'statuses: [draft]',
        'methodologies: [sdd]',
        'tags:',
        '  canonical: []',
        '  aliases: {}',
        ''
      ].join('\n')
    );
    mkdirSync(join(vaultRoot, 'notes'));
    writeFileSync(
      join(vaultRoot, 'notes/only-page.md'),
      '---\ntitle: Only Page\nkind: note\nstatus: draft\ntags: [x]\n---\nbody\n'
    );
  });

  afterEach(() => {
    const home = process.env.KMD_HOME as string;
    if (kmdHomeBefore === undefined) delete process.env.KMD_HOME;
    else process.env.KMD_HOME = kmdHomeBefore;
    rmSync(home, { recursive: true, force: true });
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  function indexedPaths(): string[] {
    const db = openDatabase(resolveIndexPath(vaultRoot));
    try {
      return (db.prepare('SELECT path FROM pages').all() as { path: string }[]).map((r) => r.path);
    } finally {
      db.close();
    }
  }

  it('sweeps the index when a valid vault holds no indexable pages', async () => {
    await syncVault(vaultRoot);
    expect(indexedPaths()).toEqual(['notes/only-page.md']);

    rmSync(join(vaultRoot, 'notes/only-page.md'));
    const stats = await syncVault(vaultRoot);

    expect(stats.pagesDeleted).toBe(1);
    expect(indexedPaths()).toEqual([]);
  });
});

describe('syncVault clock check', () => {
  let vaultRoot: string;
  let kmdHomeBefore: string | undefined;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'kmd-clock-vault-'));
    kmdHomeBefore = process.env.KMD_HOME;
    process.env.KMD_HOME = mkdtempSync(join(tmpdir(), 'kmd-clock-home-'));
    writeFileSync(
      join(vaultRoot, 'vault.yaml'),
      'scopes: {}\nkinds: [note]\nstatuses: [draft]\nmethodologies: [sdd]\ntags:\n  canonical: []\n  aliases: {}\n'
    );
    mkdirSync(join(vaultRoot, 'notes'));
  });

  afterEach(() => {
    const home = process.env.KMD_HOME as string;
    if (kmdHomeBefore === undefined) delete process.env.KMD_HOME;
    else process.env.KMD_HOME = kmdHomeBefore;
    rmSync(home, { recursive: true, force: true });
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  function page(updated: string, body: string): void {
    writeFileSync(
      join(vaultRoot, 'notes/p.md'),
      `---\ntitle: P\nkind: note\nstatus: draft\ntags: [x]\nupdated: "${updated}"\n---\n${body}\n`
    );
  }

  it('warns when content changed but updated did not advance', async () => {
    page('2026-09-02T14:00:00Z', 'first body');
    await syncVault(vaultRoot);

    page('2026-09-02T14:00:00Z', 'edited body');
    const stats = await syncVault(vaultRoot);

    expect(stats.warnings).toEqual([
      expect.objectContaining({
        path: 'notes/p.md',
        rule: 'updated-not-advanced',
        severity: 'warning'
      })
    ]);
  });
});
