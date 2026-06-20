import { describe, expect, it } from 'vitest';
import { type ParsedFrontmatter, parseFrontmatter } from './frontmatter.js';
import { buildPageFields } from './sync.js';

const known = new Set(['sotto', 'codanna']);

function parsePage(frontmatter: string): { raw: string; parsed: ParsedFrontmatter } {
  const raw = `---\n${frontmatter}\n---\nbody text\n`;
  return { raw, parsed: parseFrontmatter(raw) };
}

describe('buildPageFields scope authority', () => {
  it('indexes a page under a configured scope', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec');

    const fields = buildPageFields('projects/sotto/spec/spec-x.md', raw, parsed, known);

    expect(fields?.scope).toBe('sotto');
  });

  it('throws on a page under an unconfigured scope', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec');

    expect(() => buildPageFields('projects/ghost/spec/spec-x.md', raw, parsed, known)).toThrow(
      /ghost/
    );
  });

  it('normalizes a string `updated` (the yaml parser keeps dates as strings) to YYYY-MM-DD', () => {
    const { raw, parsed } = parsePage('title: X\nkind: spec\nupdated: 2026-04-28');

    const fields = buildPageFields('projects/sotto/spec/spec-x.md', raw, parsed, known);

    expect(fields?.updated).toBe('2026-04-28');
  });
});
