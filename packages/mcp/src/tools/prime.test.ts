import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { VaultConfig } from '../vault-config.js';
import { handlePrime, type PrimeData, renderMarkdown } from './prime.js';

const CONFIG: VaultConfig = {
  scopes: { sotto: { status: 'active' }, 'llm-wiki': { methodology: 'sdd', status: 'active' } },
  kinds: ['spec', 'adr', 'story'],
  statuses: ['draft', 'active', 'superseded', 'archived'],
  methodologies: ['sdd', 'tdd', 'hybrid'],
  tags: { canonical: ['mcp', 'sync', 'cli'], aliases: {} }
};

const EMPTY_DATA: PrimeData = {
  scope: 'llm-wiki',
  title: 'LLM Wiki',
  methodology: 'sdd',
  phase: 1,
  summary: 'tooling monorepo',
  primer: '',
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
