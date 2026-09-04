import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadManifest } from './manifest.js';
import { validatePackage } from './package.js';
import { render } from './render.js';

const SOURCE = fileURLToPath(new URL('../../../plugins/src/wiki-sdd/', import.meta.url));
const CLAUDE_MANIFEST = fileURLToPath(
  new URL('../../../plugins/claude/wiki-sdd/.claude-plugin/plugin.json', import.meta.url)
);

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const MANIFEST = { $schema: PLUGIN_SCHEMA, name: 'fixture', version: '1.0.0' };
const MCP = {
  $schema: MCP_SCHEMA,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the Agent Plugins placeholder is literal
  mcpServers: { wiki: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/x.mjs'] } }
};

function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'package-'));
  for (const [rel, value] of Object.entries(files)) {
    writeFileSync(join(root, rel), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

describe('the source is an Agent Plugins 1.0.0 package', () => {
  it('validates against the 1.0.0 schemas as wiki-sdd at the release version', () => {
    const result = validatePackage(SOURCE);
    expect(result.problems).toEqual([]);
    expect(result.manifest?.name).toBe('wiki-sdd');
    const claude = JSON.parse(readFileSync(CLAUDE_MANIFEST, 'utf8')) as { version: string };
    expect(result.manifest?.version).toBe(claude.version);
  });

  it('names every manifest schema violation by file — the schema is closed', () => {
    const root = fixture({
      'plugin.json': { ...MANIFEST, name: 'My-Plugin', skills: './skills/' },
      'mcp.json': MCP
    });
    const { problems, manifest } = validatePackage(root);
    expect(manifest).toBeNull();
    expect(problems.some((p) => p.startsWith('plugin.json:') && p.includes('/name'))).toBe(true);
    expect(problems.some((p) => p.startsWith('plugin.json:') && p.includes('(skills)'))).toBe(true);
    expect(problems.some((p) => p.startsWith('mcp.json:'))).toBe(false);
  });

  it('names the mcp.json violations — wrong schema id, a server without a transport, a missing file', () => {
    const wrongId = fixture({
      'plugin.json': MANIFEST,
      'mcp.json': { ...MCP, $schema: 'https://agent-plugins.org/schemas/0.9.0/mcp.schema.json' }
    });
    expect(validatePackage(wrongId).problems).toEqual([
      expect.stringMatching(/^mcp\.json: \/\$schema /)
    ]);

    const noType = fixture({
      'plugin.json': MANIFEST,
      'mcp.json': { ...MCP, mcpServers: { wiki: { command: 'node' } } }
    });
    const problems = validatePackage(noType).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.startsWith('mcp.json: /mcpServers/wiki'))).toBe(true);

    const missing = fixture({ 'plugin.json': MANIFEST });
    expect(validatePackage(missing).problems).toEqual([
      'mcp.json: missing — the source is the package'
    ]);
  });
});

describe('the source is harness-neutral', () => {
  it('renders from the real manifest without a harness-name finding', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const manifest = loadManifest(join(repoRoot, 'plugins', 'render-manifest.yaml'));
    expect(render(repoRoot, manifest, 'check').problems).toEqual([]);
    const skill = (flavor: string): string =>
      readFileSync(
        join(repoRoot, 'plugins', flavor, 'wiki-sdd', 'skills', 'intent', 'SKILL.md'),
        'utf8'
      );
    expect(skill('claude')).toContain('`/wiki`');
    expect(skill('codex')).toContain('`$wiki`');
  });
});
