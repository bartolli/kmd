import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultConfig } from '@llm-wiki/db/vault-config';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultBinding } from '../binding.js';
import { registerTemplateResources, TEMPLATES } from './templates.js';

// Resources never touch the index; a dummy db satisfies the binding shape.
function asBinding(vaultRoot: string, vaultConfig: VaultConfig): VaultBinding {
  return { vaultRoot, vaultConfig, db: undefined as unknown as VaultBinding['db'] };
}

const CONFIG: VaultConfig = {
  scopes: { sotto: { status: 'active' } },
  kinds: ['project', 'spec', 'adr', 'note'],
  statuses: ['draft', 'active', 'superseded', 'archived'],
  methodologies: ['sdd'],
  tags: { canonical: ['mcp'], aliases: {} }
};

const EXPERIMENT_KIND = {
  name: 'experiment',
  signal: 'Hypothesis, setup, and outcome of a lab run',
  where: '`projects/{scope}/lab/exp-{slug}.md`'
};

const CONFIG_WITH_CUSTOM: VaultConfig = {
  ...CONFIG,
  kinds: [...CONFIG.kinds, EXPERIMENT_KIND]
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

async function readResource(
  handlers: Map<string, (uri: URL) => Promise<unknown>>,
  uri: string
): Promise<string> {
  const handler = handlers.get(uri);
  expect(handler).toBeDefined();
  const result = (await handler?.(new URL(uri))) as { contents: Array<{ text: string }> };
  return result.contents[0]?.text ?? '';
}

describe('TEMPLATES array', () => {
  it('has exactly 11 entries matching the vault template set', () => {
    expect(TEMPLATES).toHaveLength(11);
  });

  it('every URI follows wiki://template/{domain}/{kind} or wiki://template/{kind}', () => {
    for (const tmpl of TEMPLATES) {
      expect(tmpl.uri).toMatch(/^wiki:\/\/template\/[\w-]+(\/[\w-]+)?$/);
    }
  });

  it('has no duplicate URIs', () => {
    const uris = TEMPLATES.map((t) => t.uri);
    expect(new Set(uris).size).toBe(uris.length);
  });
});

describe('wiki://templates index resource', () => {
  it('is registered alongside the 11 individual templates', () => {
    const { mcp } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', CONFIG));

    expect(mcp.registerResource).toHaveBeenCalledTimes(12);
  });

  it('returns markdown listing every template name and URI', async () => {
    const { mcp, handlers } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', CONFIG));

    const text = await readResource(handlers, 'wiki://templates');

    expect(text).toContain('# Wiki Templates');
    for (const tmpl of TEMPLATES) {
      expect(text).toContain(tmpl.name);
      expect(text).toContain(tmpl.uri);
    }
  });
});

describe('custom-kind templates', () => {
  it('registers wiki://template/{name} for an object-form kind, signal as description', () => {
    const { mcp, handlers } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', CONFIG_WITH_CUSTOM));

    expect(handlers.has('wiki://template/experiment')).toBe(true);
    expect(mcp.registerResource).toHaveBeenCalledWith(
      'Experiment',
      'wiki://template/experiment',
      expect.objectContaining({ description: EXPERIMENT_KIND.signal }),
      expect.any(Function)
    );
  });

  it('lists the custom kind in the wiki://templates index', async () => {
    const { mcp, handlers } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', CONFIG_WITH_CUSTOM));

    const text = await readResource(handlers, 'wiki://templates');

    expect(text).toContain('wiki://template/experiment');
    expect(text).toContain(EXPERIMENT_KIND.signal);
  });

  it('does not register a custom template for an object-form built-in kind', () => {
    const reworded: VaultConfig = {
      ...CONFIG,
      kinds: ['spec', { name: 'adr', signal: 'Reworded row', where: '`x`' }, 'note']
    };
    const { mcp, handlers } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', reworded));

    expect(handlers.has('wiki://template/adr')).toBe(false);
    expect(mcp.registerResource).toHaveBeenCalledTimes(12);
  });

  describe('serving from disk', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'wiki-templates-'));
      await mkdir(join(dir, 'templates'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('serves the custom template body fresh from templates/{name}.md', async () => {
      await writeFile(
        join(dir, 'templates', 'experiment.md'),
        '---\nkind: experiment\n---\n\n# {{title}}\n'
      );
      const { mcp, handlers } = captureMcp();
      registerTemplateResources(mcp, asBinding(dir, CONFIG_WITH_CUSTOM));

      const text = await readResource(handlers, 'wiki://template/experiment');

      expect(text).toContain('kind: experiment');
    });

    it('a declared kind without its template file errors naming the file', async () => {
      const { mcp, handlers } = captureMcp();
      registerTemplateResources(mcp, asBinding(dir, CONFIG_WITH_CUSTOM));

      const handler = handlers.get('wiki://template/experiment');
      await expect(handler?.(new URL('wiki://template/experiment'))).rejects.toThrow(
        /template file missing: templates\/experiment\.md/
      );
    });
  });
});
