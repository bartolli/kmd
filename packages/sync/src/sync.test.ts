import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { buildPageFields } from './sync.js';

const known = new Set(['sotto', 'codanna']);

function parsePage(frontmatter: string): { raw: string; parsed: matter.GrayMatterFile<string> } {
  const raw = `---\n${frontmatter}\n---\nbody text\n`;
  return { raw, parsed: matter(raw) };
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
});
