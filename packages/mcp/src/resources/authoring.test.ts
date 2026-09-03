import type { VaultConfig } from '@llm-wiki/db/vault-config';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { VaultBinding } from '../binding.js';
import { registerAuthoringResource } from './authoring.js';

// Resources never touch the index; a dummy db satisfies the binding shape.
function asBinding(vaultRoot: string, vaultConfig: VaultConfig): VaultBinding {
  return { vaultRoot, vaultConfig, db: undefined as unknown as VaultBinding['db'] };
}

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
    'prompt',
    'intent',
    'glossary'
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

describe('wiki://authoring resource', () => {
  it('registers at wiki://authoring', () => {
    const { mcp } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    expect(mcp.registerResource).toHaveBeenCalledWith(
      'Authoring guide',
      'wiki://authoring',
      expect.objectContaining({ mimeType: 'text/markdown' }),
      expect.any(Function)
    );
  });

  it('opens with the vault root — the base for every page path it teaches', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('Vault root: `/fake-vault`');
  });

  it('includes the kind selector table', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Kind selector');
    expect(text).toContain('| Signal | Kind | Where |');
    expect(text).toContain('**adr**');
    expect(text).toContain('**spec**');
    expect(text).toContain('**note**');
    expect(text).not.toContain('| — |');
  });

  it("teaches both note homes — root capture and the scope's own notes folder", async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('`projects/{scope}/notes/{slug}.md`');
    expect(text).toContain('`notes/{slug}.md`');
  });

  it('teaches the intent kind with its folder and slug pattern', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('**intent**');
    expect(text).toContain('`projects/{scope}/intent/intent-{slug}.md`');
  });

  it('teaches the glossary kind at the scope root', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('**glossary**');
    expect(text).toContain('`projects/{scope}/glossary.md`');
  });

  it('kind selector is config-driven — only configured kinds appear', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', MINIMAL_CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('**recipe**');
    expect(text).toContain('**note**');
    expect(text).not.toContain('**adr**');
    expect(text).not.toContain('**spec**');
    expect(text).not.toContain('**story**');
    expect(text).toContain('If none fits → note.');
    expect(text).not.toContain('torn between adr and spec');
  });

  it('unknown kinds get a graceful row with dashes', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', MINIMAL_CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toMatch(/\| — \| \*\*recipe\*\* \| — \|/);
  });

  it('project-kind paths include the projects/ prefix', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('`projects/{scope}/adr/adr-{slug}.md`');
    expect(text).toContain('`projects/{scope}/spec/spec-{slug}.md`');
    expect(text).toContain('`projects/{scope}/plan/plan-{slug}.md`');
    expect(text).toContain('`research/{topic}/{slug}.md`');
    expect(text).toContain('`notes/{slug}.md`');
  });

  it('includes controlled vocabulary from vault config', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Controlled vocabulary');
    expect(text).toContain('project, spec, adr');
    expect(text).toContain('draft');
    expect(text).toContain('sdd');
    expect(text).toContain('mcp, sync, cli');
    expect(text).toContain('server → mcp');
  });

  it('references wiki://templates instead of embedding the list', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Templates');
    expect(text).toContain('`wiki://templates`');
    expect(text).not.toContain('wiki://template/project/adr');
  });

  it('includes default authoring rules when authoring_rules is absent', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Authoring rules');
    expect(text).toContain('Use the matching template');
    expect(text).toContain('Quote prose-bearing scalars');
    expect(text).toContain('ADR supersession is bidirectional');
  });

  it('teaches the primer contract — four sections, the budget, the register, nothing derivable', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('The primer carries only what nothing else derives');
    expect(text).toContain('Focus, Next, Open, Read order');
    expect(text).toContain('signal-dense');
  });

  it('uses custom authoring_rules from vault config when provided', async () => {
    const custom: VaultConfig = {
      ...CONFIG,
      authoring_rules: 'Always use wikilinks for cross-references.'
    };
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', custom));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Authoring rules');
    expect(text).toContain('Always use wikilinks for cross-references.');
    expect(text).not.toContain('Use the matching template');
  });

  it('includes default resync protocol when sync_protocol is absent', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Resync protocol');
    expect(text).toContain('smallest set of files');
  });

  it('uses custom sync_protocol from vault config when provided', async () => {
    const custom: VaultConfig = {
      ...CONFIG,
      sync_protocol: 'Always run wiki validate after edits.'
    };
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', custom));
    const text = await readAuthoring(handlers);

    expect(text).toContain('## Resync protocol');
    expect(text).toContain('Always run wiki validate after edits.');
    expect(text).not.toContain('smallest set of files');
  });

  it('appends authoring_rules_extra after the default rules', async () => {
    const custom: VaultConfig = {
      ...CONFIG,
      authoring_rules_extra: '- Vault-specific extra rule.'
    };
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', custom));
    const text = await readAuthoring(handlers);

    expect(text).toContain('Use the matching template');
    expect(text).toContain('Vault-specific extra rule.');
    expect(text.indexOf('Vault-specific extra rule.')).toBeGreaterThan(
      text.indexOf('Use the matching template')
    );
  });

  it('appends authoring_rules_extra after a full replacement', async () => {
    const custom: VaultConfig = {
      ...CONFIG,
      authoring_rules: 'Replaced rules.',
      authoring_rules_extra: '- Vault-specific extra rule.'
    };
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', custom));
    const text = await readAuthoring(handlers);

    expect(text).toContain('Replaced rules.');
    expect(text).toContain('Vault-specific extra rule.');
    expect(text).not.toContain('Use the matching template');
  });

  it('appends sync_protocol_extra after the default protocol', async () => {
    const custom: VaultConfig = {
      ...CONFIG,
      sync_protocol_extra: 'Session-closing resyncs run /retro first.'
    };
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', custom));
    const text = await readAuthoring(handlers);

    expect(text).toContain('smallest set of files');
    expect(text).toContain('Session-closing resyncs run /retro first.');
  });

  it('renders selector pedagogy for object-form kind entries', async () => {
    const custom: VaultConfig = {
      ...MINIMAL_CONFIG,
      kinds: [
        { name: 'recipe', signal: 'Cooking recipe with steps', where: '`recipes/{slug}.md`' },
        'note'
      ]
    };
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', custom));
    const text = await readAuthoring(handlers);

    expect(text).toContain('| Cooking recipe with steps | **recipe** | `recipes/{slug}.md` |');
    expect(text).not.toMatch(/\| — \| \*\*recipe\*\* \| — \|/);
  });

  it('renders the canonical status set as a one-directional flow', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('**Statuses:** draft → active → superseded → archived (one-directional');
  });

  it('renders a custom status set as a plain list without lifecycle claims', async () => {
    const { mcp, handlers } = captureMcp();
    registerAuthoringResource(mcp, asBinding('/fake-vault', MINIMAL_CONFIG));
    const text = await readAuthoring(handlers);

    expect(text).toContain('**Statuses:** draft, published');
    expect(text).not.toContain('one-directional');
    expect(text).not.toContain('draft → published');
  });
});
