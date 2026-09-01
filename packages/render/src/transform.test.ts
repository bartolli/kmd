import { describe, expect, it } from 'vitest';
import { transformCoco, transformCodex, transformKiro } from './transform.js';

describe('transformCodex', () => {
  it('rewrites slash invocations to dollar', () => {
    const out = transformCodex('Run `/wiki` then `/grill-with-docs`.', {
      slashNames: ['wiki', 'grill-with-docs'],
      replacements: []
    });
    expect(out).toBe('Run `$wiki` then `$grill-with-docs`.');
  });

  it('leaves path segments and compound names untouched', () => {
    const text = 'See skills/wiki/SKILL.md in plugins/wiki-sdd.';
    expect(transformCodex(text, { slashNames: ['wiki'], replacements: [] })).toBe(text);
  });

  it('rewrites bare Claude on word boundaries, preserving CLAUDE.md and Claude Code', () => {
    const none = { slashNames: [], replacements: [] as [string, string][] };
    expect(transformCodex('When Claude edits, solo+Claude applies.', none)).toBe(
      'When Codex edits, solo+Codex applies.'
    );
    expect(transformCodex('`CLAUDE.md` stays.', none)).toBe('`CLAUDE.md` stays.');
    expect(transformCodex('Claude Code uses `.mcp.json`; Claude reads it.', none)).toBe(
      'Claude Code uses `.mcp.json`; Codex reads it.'
    );
  });

  it('applies literal replacements before the slash and Claude rules', () => {
    const out = transformCodex('Read `CLAUDE.md` or `AGENTS.md`.', {
      slashNames: [],
      replacements: [['Read `CLAUDE.md` or `AGENTS.md`.', 'Read `AGENTS.md`.']]
    });
    expect(out).toBe('Read `AGENTS.md`.');
  });

  it('aliases match longest-first so compound names win', () => {
    const out = transformCodex('Triggers on /dense and /signal-dense.', {
      slashNames: ['signal-dense', 'dense'],
      replacements: []
    });
    expect(out).toBe('Triggers on $dense and $signal-dense.');
  });
});

describe('transformKiro', () => {
  it('keeps slash invocations and rewrites bare Claude to Kiro', () => {
    const out = transformKiro('Run `/wiki`; Claude Code stays, Claude changes.', {
      slashNames: ['wiki'],
      replacements: []
    });
    expect(out).toBe('Run `/wiki`; Claude Code stays, Kiro changes.');
  });
});

describe('transformCoco', () => {
  it('rewrites slash invocations to dollar and bare Claude to CoCo', () => {
    const out = transformCoco('Run `/wiki`; Claude Code stays, Claude changes.', {
      slashNames: ['wiki'],
      replacements: []
    });
    expect(out).toBe('Run `$wiki`; Claude Code stays, CoCo changes.');
  });

  it('leaves CLAUDE.md alone — CoCo reads it as a project-instructions file', () => {
    const text = 'Read `CLAUDE.md` or `AGENTS.md`.';
    expect(transformCoco(text, { slashNames: [], replacements: [] })).toBe(text);
  });
});
