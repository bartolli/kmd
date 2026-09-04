import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RenderManifest } from './render.js';
import { render } from './render.js';

const SKILL = `---
name: foo
description: Use /foo when the agent needs it.
---

Run \`/foo\` when the agent asks. The token stays a path in skills/foo/SKILL.md.
`;

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

let root: string;

function write(rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function manifest(): RenderManifest {
  return {
    sourceRoot: 'src/wiki-sdd',
    flavors: {
      claude: { dest: 'plugins/claude/wiki-sdd', dialect: { kind: 'claude' } },
      codex: {
        dest: 'plugins/codex/wiki-sdd',
        dialect: { kind: 'codex', slashAliases: [], replacements: [] }
      },
      coco: {
        dest: 'plugins/coco/wiki-sdd',
        dialect: { kind: 'coco', slashAliases: [], replacements: [] }
      },
      kiro: { dest: 'plugins/kiro/wiki-sdd', dialect: { kind: 'kiro', replacements: [] } }
    },
    shared: { exact: [], rendered: ['skills/foo/SKILL.md'] }
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'render-'));
  write('src/wiki-sdd/skills/foo/SKILL.md', SKILL);
  write(
    'src/wiki-sdd/plugin.json',
    JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'wiki-sdd', version: '1.2.3' })
  );
  write(
    'src/wiki-sdd/mcp.json',
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the Agent Plugins placeholder is literal
        wiki: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/x.mjs', 'mcp'] }
      }
    })
  );
});

describe('render', () => {
  it('propagates a shared edit into every flavor with no hand mirroring', () => {
    const result = render(root, manifest(), 'write');
    expect(result.problems).toEqual([]);

    expect(read('plugins/claude/wiki-sdd/skills/foo/SKILL.md')).toBe(SKILL);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `$foo` when the agent asks. The token stays a path in skills/foo/SKILL.md.'
    );
    expect(read('plugins/coco/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `$foo` when the agent asks.'
    );
    expect(read('plugins/kiro/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `/foo` when the agent asks.'
    );

    const again = render(root, manifest(), 'write');
    expect(again.problems).toEqual([]);
    expect(read('plugins/claude/wiki-sdd/skills/foo/SKILL.md')).toBe(SKILL);
  });

  it('never touches per-harness chrome', () => {
    write('plugins/codex/wiki-sdd/hooks/hooks.json', 'codex-specific');
    write('plugins/codex/wiki-sdd/.mcp.json', '{"codex": true}');
    render(root, manifest(), 'write');
    expect(read('plugins/codex/wiki-sdd/hooks/hooks.json')).toBe('codex-specific');
    expect(read('plugins/codex/wiki-sdd/.mcp.json')).toBe('{"codex": true}');
  });

  it('removes stale files from a dest skills tree — adapters are build output', () => {
    write('plugins/kiro/wiki-sdd/skills/stale/SKILL.md', 'gone after render');
    render(root, manifest(), 'write');
    expect(existsSync(join(root, 'plugins/kiro/wiki-sdd/skills/stale'))).toBe(false);
    expect(read('plugins/kiro/wiki-sdd/skills/foo/SKILL.md')).toContain('Run `/foo`');
  });

  it('fails the render when CLAUDE.md survives a dialect transform, writing nothing', () => {
    write('src/wiki-sdd/skills/foo/SKILL.md', 'Edit `CLAUDE.md` directly.\n');
    const result = render(root, manifest(), 'write');
    expect(result.problems.some((p) => p.includes('CLAUDE.md') && p.includes('foo/SKILL.md'))).toBe(
      true
    );
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });

  it('lets an allowed CLAUDE.md reach the coco flavor — CoCo reads it as project instructions', () => {
    write('src/wiki-sdd/skills/foo/SKILL.md', 'Edit `CLAUDE.md` directly.\n');
    const cocoOnly: RenderManifest = {
      sourceRoot: 'src/wiki-sdd',
      flavors: {
        coco: {
          dest: 'plugins/coco/wiki-sdd',
          dialect: { kind: 'coco', slashAliases: [], replacements: [] }
        }
      },
      shared: { exact: [], rendered: ['skills/foo/SKILL.md'] },
      lintAllow: ['Edit `CLAUDE.md` directly.']
    };
    const result = render(root, cocoOnly, 'write');
    expect(result.problems).toEqual([]);
    expect(read('plugins/coco/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Edit `CLAUDE.md` directly.'
    );
  });

  it('fails the render when a kiro description exceeds 1024 parsed chars', () => {
    const long = 'x'.repeat(1030);
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: >\n  ${long}\n---\n\nBody.\n`
    );
    const result = render(root, manifest(), 'write');
    expect(result.problems.some((p) => p.includes('1024') && p.includes('foo'))).toBe(true);
  });

  it('fails the render when a SKILL.md name does not match its folder', () => {
    write('src/wiki-sdd/skills/foo/SKILL.md', '---\nname: other\ndescription: Ok.\n---\n\nBody.\n');
    const result = render(root, manifest(), 'write');
    expect(result.problems.some((p) => p.includes('other') && p.includes('foo'))).toBe(true);
  });

  it('check mode passes a fresh render and reports tampering and stale files', () => {
    render(root, manifest(), 'write');
    expect(render(root, manifest(), 'check').mismatches).toEqual([]);

    write('plugins/codex/wiki-sdd/skills/foo/SKILL.md', 'hand edit');
    write('plugins/claude/wiki-sdd/skills/rogue/SKILL.md', 'unmanaged');
    const result = render(root, manifest(), 'check');
    expect(result.mismatches.some((m) => m.includes('codex') && m.includes('foo/SKILL.md'))).toBe(
      true
    );
    expect(result.mismatches.some((m) => m.includes('claude') && m.includes('rogue'))).toBe(true);
  });

  it('lets lintAllow literals survive a dialect transform while unlisted CLAUDE.md still fails', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\n---\n\n| Claude Code | `CLAUDE.md` or `AGENTS.md` (step 6) |\n'
    );
    const m = manifest();
    m.lintAllow = ['| Claude Code | `CLAUDE.md` or `AGENTS.md` (step 6) |'];
    expect(render(root, m, 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(
      '`CLAUDE.md` or `AGENTS.md` (step 6)'
    );

    write('src/wiki-sdd/skills/foo/SKILL.md', 'Also edit `CLAUDE.md` directly.\n');
    const result = render(root, m, 'write');
    expect(result.problems.some((p) => p.includes('CLAUDE.md'))).toBe(true);
  });

  it('stamps metadata.version into rendered SKILL.md files from the version source', () => {
    write('plugins/claude/wiki-sdd/.claude-plugin/plugin.json', '{"version": "0.2.0"}');
    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'wiki-sdd', version: '0.2.0' })
    );
    const m = manifest();
    m.versionSource = 'plugins/claude/wiki-sdd/.claude-plugin/plugin.json';
    expect(render(root, m, 'write').problems).toEqual([]);

    for (const flavor of ['claude', 'codex', 'kiro']) {
      const out = read(`plugins/${flavor}/wiki-sdd/skills/foo/SKILL.md`);
      expect(out).toMatch(/metadata:\n {2}version: "0\.2\.0"\n---/);
    }
    expect(render(root, m, 'check').mismatches).toEqual([]);
  });

  it('fails the render when a source SKILL.md declares its own metadata block', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\nmetadata:\n  version: "9.9.9"\n---\n\nBody.\n'
    );
    write('plugins/claude/wiki-sdd/.claude-plugin/plugin.json', '{"version": "0.2.0"}');
    const m = manifest();
    m.versionSource = 'plugins/claude/wiki-sdd/.claude-plugin/plugin.json';
    const result = render(root, m, 'write');
    expect(result.problems.some((p) => p.includes('metadata'))).toBe(true);
  });

  it('writes flavor-restricted exact files only into their listed flavors', () => {
    write('src/wiki-sdd/hooks/run-kmd-hook.mjs', 'wrapper bytes');
    const m = manifest();
    m.shared.exact = [{ path: 'hooks/run-kmd-hook.mjs', flavors: ['claude', 'codex'] }];
    render(root, m, 'write');
    expect(read('plugins/claude/wiki-sdd/hooks/run-kmd-hook.mjs')).toBe('wrapper bytes');
    expect(read('plugins/codex/wiki-sdd/hooks/run-kmd-hook.mjs')).toBe('wrapper bytes');
    expect(existsSync(join(root, 'plugins/kiro/wiki-sdd/hooks/run-kmd-hook.mjs'))).toBe(false);
  });
});

describe('the source package', () => {
  it('stops the render on an invalid source manifest, writing nothing', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'Bad Name' }));
    const result = render(root, manifest(), 'write');
    expect(result.problems).toEqual([expect.stringMatching(/^plugin\.json: \/name /)]);
    expect(existsSync(join(root, 'plugins/claude/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });
});

describe('one version', () => {
  it('fails when the root manifest version differs from versionSource', () => {
    write(
      'plugins/claude/wiki-sdd/.claude-plugin/plugin.json',
      JSON.stringify({ version: '0.20.0' })
    );
    const m = {
      ...manifest(),
      versionSource: 'plugins/claude/wiki-sdd/.claude-plugin/plugin.json'
    };
    const result = render(root, m, 'check');
    expect(result.problems).toEqual([
      'plugin.json: version 1.2.3 differs from versionSource 0.20.0 — one version ships everywhere'
    ]);

    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'wiki-sdd', version: '0.20.0' })
    );
    expect(render(root, m, 'write').problems).toEqual([]);
  });
});

describe('harness-neutral source', () => {
  it('stops the render on a bare harness name in a skill body, writing nothing', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\n---\n\nRun `/foo` when Claude asks; Kiro reads `CLAUDE.md`.\n'
    );
    const result = render(root, manifest(), 'write');
    const named = result.problems.filter((p) => p.includes('harness name'));
    expect(named).toEqual([
      expect.stringMatching(/^skills\/foo\/SKILL\.md: harness name `Claude` /),
      expect.stringMatching(/^skills\/foo\/SKILL\.md: harness name `Kiro` /),
      expect.stringMatching(/^skills\/foo\/SKILL\.md: harness name `CLAUDE\.md` /)
    ]);
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });
});

describe('allowed harness-placement section', () => {
  const TABLE =
    '| | Claude Code | Codex | CoCo | Kiro |\n| Project instructions | `CLAUDE.md` | `AGENTS.md` | `CORTEX.md` | `AGENTS.md` |\n';

  it('exempts one section by heading from both lints, and nothing outside it', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: Ok.\n---\n\n## Mental model\n\nThe agent reads the project instructions.\n\n### Harness placement\n\n${TABLE}\n### Gate hooks\n\nGates read the project from each event.\n`
    );
    const m = manifest();
    m.lintAllow = [{ section: '### Harness placement' }];
    expect(render(root, m, 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(TABLE);

    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: Ok.\n---\n\n### Harness placement\n\n${TABLE}\n### Gate hooks\n\nKiro reads \`CLAUDE.md\` here.\n`
    );
    const named = render(root, m, 'write').problems.filter((p) => p.includes('harness name'));
    expect(named).toEqual([
      expect.stringMatching(/harness name `Kiro` /),
      expect.stringMatching(/harness name `CLAUDE\.md` /)
    ]);
  });
});
