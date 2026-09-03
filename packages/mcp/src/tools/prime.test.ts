import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@llm-wiki/db/database';
import type { VaultConfig } from '@llm-wiki/db/vault-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePrime, type PrimeData, prime, renderMarkdown } from './prime.js';

const CONFIG: VaultConfig = {
  scopes: { sotto: { status: 'active' }, 'llm-wiki': { methodology: 'sdd', status: 'active' } },
  kinds: ['spec', 'adr', 'story'],
  statuses: ['draft', 'active', 'superseded', 'archived'],
  methodologies: ['sdd', 'tdd', 'hybrid'],
  tags: { canonical: ['mcp', 'sync', 'cli'], aliases: {} }
};

const EMPTY_DATA: PrimeData = {
  scope: 'llm-wiki',
  vault_root: '/vaults/wiki',
  title: 'LLM Wiki',
  methodology: 'sdd',
  phase: 1,
  summary: 'tooling monorepo',
  primer: '',
  glossary: '',
  counts: {},
  active_adrs: [],
  current_plan: null,
  top_tags: [],
  hub_pages: [],
  recent: [],
  relevant: [],
  cross_scope: []
};

describe('handlePrime scope validation', () => {
  it('rejects an unlisted scope with UNKNOWN_SCOPE before any DB access', async () => {
    const prepare = vi.fn(() => {
      throw new Error('DB must not be touched for an unknown scope');
    });
    const db = { prepare } as unknown as DatabaseSync;

    const result = await handlePrime(
      { db, vaultRoot: '/nonexistent', vaultConfig: CONFIG },
      { scope: 'bogus' }
    );

    expect(result.structuredContent.code).toBe('UNKNOWN_SCOPE');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects an Object.prototype member name as an unknown scope', async () => {
    const prepare = vi.fn(() => {
      throw new Error('DB must not be touched for a prototype-member scope');
    });
    const db = { prepare } as unknown as DatabaseSync;

    const result = await handlePrime(
      { db, vaultRoot: '/nonexistent', vaultConfig: CONFIG },
      { scope: 'constructor' }
    );

    expect(result.structuredContent.code).toBe('UNKNOWN_SCOPE');
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('renderMarkdown Vocabulary section', () => {
  it('renders the kinds, statuses, and canonical tags from config', () => {
    const md = renderMarkdown(EMPTY_DATA, CONFIG, undefined);

    expect(md).toContain('## Vocabulary');
    expect(md).toContain('story'); // a kind
    expect(md).toContain('superseded'); // a status
    expect(md).toContain('mcp'); // a canonical tag
  });

  it('inlines the glossary Language section under Vocabulary, after the config lines', () => {
    const language =
      '**Starter**:\nThe engine constant `kmd init` serializes.\n_Avoid_: "default config".';

    const md = renderMarkdown({ ...EMPTY_DATA, glossary: language }, CONFIG, undefined);

    const at = (s: string) => md.indexOf(s);
    expect(at('## Vocabulary')).toBeLessThan(at('tags: mcp, sync, cli'));
    expect(at('tags: mcp, sync, cli')).toBeLessThan(at(language));
    expect(at(language)).toBeLessThan(at('---\nAuthoring wiki content?'));
  });

  it('carries no glossary text when the scope has none', () => {
    const md = renderMarkdown({ ...EMPTY_DATA, glossary: '' }, CONFIG, undefined);

    expect(md.split('## Vocabulary')[1]?.split('\n---')[0]?.trim().split('\n')).toEqual([
      'kinds: spec, adr, story',
      'statuses: draft, active, superseded, archived',
      'tags: mcp, sync, cli'
    ]);
  });

  it('states the vault root — the base for search-returned relative paths', () => {
    const md = renderMarkdown(EMPTY_DATA, CONFIG, undefined);

    expect(md).toContain('Vault root: `/vaults/wiki`');
  });

  it('ends with an authoring-guide footer carrying the validate step', () => {
    const md = renderMarkdown(EMPTY_DATA, CONFIG, undefined);
    const lines = md.split('\n');
    const last = lines[lines.length - 1];

    expect(last).toContain('wiki://authoring');
    expect(last).toContain('kmd validate');
  });

  it('renders object-form kind entries by name', () => {
    const cfg: VaultConfig = {
      ...CONFIG,
      kinds: ['spec', { name: 'experiment', signal: 'Lab log', where: '`lab/{slug}.md`' }]
    };

    const md = renderMarkdown(EMPTY_DATA, cfg, undefined);

    expect(md).toContain('kinds: spec, experiment');
    expect(md).not.toContain('[object Object]');
  });

  it('serves each vault its own vocabulary — same binary, no recompile', () => {
    const other: VaultConfig = {
      scopes: { elsewhere: { status: 'active' } },
      kinds: ['recipe'],
      statuses: ['live'],
      methodologies: ['sdd'],
      tags: { canonical: ['cooking'], aliases: {} }
    };

    const a = renderMarkdown(EMPTY_DATA, CONFIG, undefined);
    const b = renderMarkdown(EMPTY_DATA, other, undefined);

    expect(a).toContain('story');
    expect(a).not.toContain('recipe');
    expect(b).toContain('recipe');
    expect(b).not.toContain('story');
  });
});

const LANGUAGE = [
  '**Starter**:',
  'The engine constant `kmd init` serializes into a fresh vault.',
  '_Avoid_: "default config".',
  '',
  '**Vault delta**:',
  'An additive difference between a vault and the Starter.'
].join('\n');

const GLOSSARY = [
  '---',
  'title: Sotto glossary',
  'kind: glossary',
  'scope: sotto',
  'status: active',
  'summary: terms',
  'tags: [vocabulary]',
  'created: "2026-09-03T00:00:00Z"',
  'updated: "2026-09-03T00:00:00Z"',
  '---',
  '',
  '# Sotto glossary',
  '',
  '## Language',
  '',
  LANGUAGE,
  '',
  '## Relationships',
  '',
  'The Starter owns the Vault delta.',
  '',
  '## Example dialogue',
  '',
  'Operator: is the vault behind the Starter?',
  '',
  '## Flagged ambiguities',
  '',
  "Drift: the session's word, never the vault's.",
  ''
].join('\n');

describe('prime inlines the glossary', () => {
  let root: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kmd-prime-'));
    await mkdir(join(root, 'projects', 'sotto'), { recursive: true });
    db = openDatabase(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('carries the Language section verbatim and none of the other sections', async () => {
    await writeFile(join(root, 'projects', 'sotto', 'glossary.md'), GLOSSARY);

    const { data, markdown } = await prime(
      { db, vaultRoot: root, vaultConfig: CONFIG },
      { scope: 'sotto' }
    );

    expect(data.glossary).toBe(LANGUAGE);
    expect(markdown).toContain(LANGUAGE);
    for (const absent of [
      '## Relationships',
      'owns the Vault delta',
      'Operator:',
      'Drift:',
      '## Language'
    ]) {
      expect(markdown).not.toContain(absent);
    }
  });

  it('is silent when the scope has no glossary', async () => {
    const { data, markdown } = await prime(
      { db, vaultRoot: root, vaultConfig: CONFIG },
      { scope: 'sotto' }
    );

    expect(data.glossary).toBe('');
    expect(markdown.split('## Vocabulary')[1]?.split('\n---')[0]?.trim().split('\n')).toEqual([
      'kinds: spec, adr, story',
      'statuses: draft, active, superseded, archived',
      'tags: mcp, sync, cli'
    ]);
  });

  it('never inlines spec-context.md, with or without a glossary beside it', async () => {
    await mkdir(join(root, 'projects', 'sotto', 'spec'), { recursive: true });
    const legacy =
      '---\ntitle: Context\nkind: spec\n---\n\n## Language\n\n**Legacy term**:\nfrom the old file.\n';
    await writeFile(join(root, 'projects', 'sotto', 'spec', 'spec-context.md'), legacy);

    const without = await prime({ db, vaultRoot: root, vaultConfig: CONFIG }, { scope: 'sotto' });
    await writeFile(join(root, 'projects', 'sotto', 'glossary.md'), GLOSSARY);
    const beside = await prime({ db, vaultRoot: root, vaultConfig: CONFIG }, { scope: 'sotto' });

    expect(without.data.glossary).toBe('');
    expect(beside.data.glossary).toBe(LANGUAGE);
    expect(beside.markdown).not.toContain('Legacy term');
  });
});
