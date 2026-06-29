import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { VaultConfig } from '../vault-config.js';
import { registerAuthoringResource } from './authoring.js';

const CONFIG: VaultConfig = {
  scopes: { sotto: { status: 'active' } },
  kinds: [
    'project',
    'spec',
    'adr',
    'plan',
    'story',
    'ops',
    'topic',
    'article',
    'src',
    'note',
    'artifact',
    'prompt'
  ],
  statuses: ['draft', 'active', 'superseded', 'archived'],
  methodologies: ['sdd', 'tdd', 'hybrid'],
  tags: { canonical: ['mcp', 'sync', 'cli'], aliases: { server: 'mcp' } }
};

const MINIMAL_CONFIG: VaultConfig = {
  scopes: { recipes: { status: 'active' } },
  kinds: ['recipe', 'note'],
  statuses: ['draft', 'published'],
  methodologies: ['sdd'],
  tags: { canonical: ['cooking'], aliases: {} }
};

function captureMcp() {
  const handlers = new Map<string, (uri: URL) => Promise<unknown>>();
  const mcp = {
    registerResource: vi.fn(
      (_name: string, uri: string, _meta: unknown, handler: (uri: URL) => Promise<unknown>) => {
        handlers.set(uri, handler);
      }
    )
  } as unknown as McpServer;
  return { mcp, handlers };
}

async function readAuthoring(
  handlers: Map<string, (uri: URL) => Promise<unknown>>
): Promise<string> {
  const handler = handlers.get('wiki://authoring');
  expect(handler).toBeDefined();
  const result = (await handler?.(new URL('wiki://authoring'))) as {
    contents: Array<{ text: string }>;
  };
  return result.contents[0]?.text ?? '';
}

async function withTmpVault(fn: (vaultRoot: string) => Promise<void>): Promise<void> {
  const dir = join(tmpdir(), `authoring-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('wiki://authoring resource', () => {
  it('registers at wiki://authoring', () => {
    const { mcp } = captureMcp();
    registerAuthoringResource(mcp, '/fake-vault', CONFIG);
    expect(mcp.registerResource).toHaveBeenCalledWith(
      'Authoring guide',
      'wiki://authoring',
      expect.objectContaining({ mimeType: 'text/markdown' }),
      expect.any(Function)
    );
  });

  it('includes the kind selector table', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('## Kind selector');
      expect(text).toContain('| Signal | Kind | Where |');
      expect(text).toContain('**adr**');
      expect(text).toContain('**spec**');
      expect(text).toContain('**note**');
      expect(text).not.toContain('| — |');
    });
  });

  it('kind selector is config-driven — only configured kinds appear', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, MINIMAL_CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('**recipe**');
      expect(text).toContain('**note**');
      expect(text).not.toContain('**adr**');
      expect(text).not.toContain('**spec**');
      expect(text).not.toContain('**story**');
      expect(text).toContain('If none fits → note.');
      expect(text).not.toContain('torn between adr and spec');
    });
  });

  it('unknown kinds get a graceful row with dashes', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, MINIMAL_CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toMatch(/\| — \| \*\*recipe\*\* \| — \|/);
    });
  });

  it('project-kind paths include the projects/ prefix', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('`projects/{scope}/adr/adr-{slug}.md`');
      expect(text).toContain('`projects/{scope}/spec/spec-{slug}.md`');
      expect(text).toContain('`projects/{scope}/plan/plan-{slug}.md`');
      expect(text).toContain('`research/{topic}/{slug}.md`');
      expect(text).toContain('`notes/{slug}.md`');
    });
  });

  it('includes controlled vocabulary from vault config', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('## Controlled vocabulary');
      expect(text).toContain('project, spec, adr');
      expect(text).toContain('draft');
      expect(text).toContain('sdd');
      expect(text).toContain('mcp, sync, cli');
      expect(text).toContain('server → mcp');
    });
  });

  it('references wiki://templates instead of embedding the list', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('## Templates');
      expect(text).toContain('`wiki://templates`');
      expect(text).not.toContain('wiki://template/project/adr');
    });
  });

  it('includes authoring rules when vault CLAUDE.md has the section', async () => {
    await withTmpVault(async (vaultRoot) => {
      await writeFile(
        join(vaultRoot, 'CLAUDE.md'),
        [
          '# Vault docs',
          '',
          '## Authoring rules',
          '',
          '- Always use wikilinks for cross-references.',
          '- Keep summaries under 120 chars.',
          '',
          '## Other section',
          '',
          'Unrelated content.'
        ].join('\n')
      );

      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('## Authoring rules');
      expect(text).toContain('Always use wikilinks');
      expect(text).toContain('Keep summaries under 120 chars');
      expect(text).not.toContain('Unrelated content');
    });
  });

  it('omits authoring rules when vault CLAUDE.md is absent', async () => {
    await withTmpVault(async (vaultRoot) => {
      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).toContain('## Kind selector');
      expect(text).not.toContain('## Authoring rules');
    });
  });

  it('handles a CLAUDE.md with no authoring-rules heading', async () => {
    await withTmpVault(async (vaultRoot) => {
      await writeFile(join(vaultRoot, 'CLAUDE.md'), '# Vault docs\n\nJust some notes.\n');

      const { mcp, handlers } = captureMcp();
      registerAuthoringResource(mcp, vaultRoot, CONFIG);
      const text = await readAuthoring(handlers);

      expect(text).not.toContain('## Authoring rules');
      expect(text).toContain('## Kind selector');
    });
  });
});
