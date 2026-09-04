import { describe, expect, it } from 'vitest';
import { transformCoco, transformCodex } from './transform.js';

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

  it('leaves a folder segment after a placeholder untouched — `{scope}/intent/` is a path, `/intent` is a skill', () => {
    const cfg = { slashNames: ['intent'], replacements: [] as [string, string][] };
    const path =
      'Lives at `projects/{scope}/intent/intent-{slug}.md` and `projects/<scope>/intent/`.';
    expect(transformCodex(path, cfg)).toBe(path);
    expect(transformCodex('Run `/intent` first.', cfg)).toBe('Run `$intent` first.');
  });

  it('rewrites nothing but the token — the source names no harness', () => {
    const none = { slashNames: [], replacements: [] as [string, string][] };
    const text = 'When the agent edits, the project instructions apply.';
    expect(transformCodex(text, none)).toBe(text);
  });

  it('applies literal replacements before the slash rule', () => {
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

describe('transformCoco', () => {
  it('rewrites slash invocations to dollar', () => {
    const out = transformCoco('Run `/wiki` when the agent asks.', {
      slashNames: ['wiki'],
      replacements: []
    });
    expect(out).toBe('Run `$wiki` when the agent asks.');
  });

  it('leaves CLAUDE.md alone — CoCo reads it as a project-instructions file', () => {
    const text = 'Read `CLAUDE.md` or `AGENTS.md`.';
    expect(transformCoco(text, { slashNames: [], replacements: [] })).toBe(text);
  });
});
