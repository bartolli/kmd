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
  it('has exactly 13 entries — 12 vault template files, the note file under both domains', () => {
    expect(TEMPLATES).toHaveLength(13);
  });

  it('serves the note template under the project domain too — scoped notes share the file', () => {
    const scoped = TEMPLATES.find((t) => t.uri === 'wiki://template/project/note');
    const root = TEMPLATES.find((t) => t.uri === 'wiki://template/note');

    expect(scoped?.file).toBe('note.md');
    expect(root?.file).toBe('note.md');
  });

  it('serves the intent template in the project domain', () => {
    const intent = TEMPLATES.find((t) => t.uri === 'wiki://template/project/intent');

    expect(intent?.file).toBe('project-intent.md');
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
  it('is registered alongside the 13 individual templates', () => {
    const { mcp } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', CONFIG));

    expect(mcp.registerResource).toHaveBeenCalledTimes(14);
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

  it('treats an object-form intent entry as built-in — no custom template registered', () => {
    const { mcp } = captureMcp();
    const intentObjectForm: VaultConfig = {
      ...CONFIG,
      kinds: [...CONFIG.kinds, { name: 'intent', signal: 'Reworded', where: '`x`' }]
    };

    registerTemplateResources(mcp, asBinding('/fake-vault', intentObjectForm));

    expect(mcp.registerResource).toHaveBeenCalledTimes(14);
  });

  it('does not register a custom template for an object-form built-in kind', () => {
    const reworded: VaultConfig = {
      ...CONFIG,
      kinds: ['spec', { name: 'adr', signal: 'Reworded row', where: '`x`' }, 'note']
    };
    const { mcp, handlers } = captureMcp();
    registerTemplateResources(mcp, asBinding('/fake-vault', reworded));

    expect(handlers.has('wiki://template/adr')).toBe(false);
    expect(mcp.registerResource).toHaveBeenCalledTimes(14);
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

    it('a built-in template missing from the vault names kmd init --upgrade as the remedy', async () => {
      const { mcp, handlers } = captureMcp();
      registerTemplateResources(mcp, asBinding(dir, CONFIG));

      const handler = handlers.get('wiki://template/project/spec');
      await expect(handler?.(new URL('wiki://template/project/spec'))).rejects.toThrow(
        /template file missing: templates\/project-spec\.md .*— run kmd init --upgrade$/
      );
    });

    it('a custom kind without its template file does not name --upgrade', async () => {
      const { mcp, handlers } = captureMcp();
      registerTemplateResources(mcp, asBinding(dir, CONFIG_WITH_CUSTOM));

      const handler = handlers.get('wiki://template/experiment');
      await expect(handler?.(new URL('wiki://template/experiment'))).rejects.not.toThrow(
        /--upgrade/
      );
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
