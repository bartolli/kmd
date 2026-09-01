import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RenderManifest } from './render.js';
import { render } from './render.js';

const SKILL = `---
name: foo
description: Use /foo when Claude needs it.
---

Run \`/foo\` when Claude asks. Claude Code stays.
`;

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
      claude: { dest: 'plugins/claude/wiki-sdd', dialect: { kind: 'identity' } },
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
});

describe('render', () => {
  it('propagates a shared edit into every flavor with no hand mirroring', () => {
    const result = render(root, manifest(), 'write');
    expect(result.problems).toEqual([]);

    expect(read('plugins/claude/wiki-sdd/skills/foo/SKILL.md')).toBe(SKILL);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `$foo` when Codex asks.'
    );
    expect(read('plugins/coco/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `$foo` when CoCo asks.'
    );
    expect(read('plugins/kiro/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `/foo` when Kiro asks.'
    );
    expect(read('plugins/kiro/wiki-sdd/skills/foo/SKILL.md')).toContain('Claude Code stays.');

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

  it('lets CLAUDE.md survive the coco transform — CoCo reads it as project instructions', () => {
    write('src/wiki-sdd/skills/foo/SKILL.md', 'Edit `CLAUDE.md` directly.\n');
    const cocoOnly: RenderManifest = {
      sourceRoot: 'src/wiki-sdd',
      flavors: {
        coco: {
          dest: 'plugins/coco/wiki-sdd',
          dialect: { kind: 'coco', slashAliases: [], replacements: [] }
        }
      },
      shared: { exact: [], rendered: ['skills/foo/SKILL.md'] }
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
    m.lintAllow = ['`CLAUDE.md` or `AGENTS.md` (step 6)'];
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
