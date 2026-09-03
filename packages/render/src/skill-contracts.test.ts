import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKILLS = fileURLToPath(new URL('../../../plugins/src/wiki-sdd/skills/', import.meta.url));

function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

/** Shape lock for intent-intent-skill-primer-stub-old-shape. */
describe('primer contract across the skill sources', () => {
  const OLD_SECTIONS = /^## (Current Focus|Open Questions|Blocked On|Working set)$/m;

  it('no skill source names a section of the six-section primer', () => {
    const offenders = markdownUnder(SKILLS)
      .filter((f) => OLD_SECTIONS.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SKILLS.length));

    expect(offenders).toEqual([]);
  });

  it('the intent skill stub carries the four sections in the served order', () => {
    const intent = readFileSync(join(SKILLS, 'intent', 'SKILL.md'), 'utf8');
    const headings = [...intent.matchAll(/^## (Focus|Next|Open|Read order)$/gm)].map((m) => m[1]);

    expect(headings).toEqual(['Focus', 'Next', 'Open', 'Read order']);
  });
});

/** Shape lock for story-glossary-scope-root-vocabulary slice 3. */
describe('glossary contract across the skill sources', () => {
  it('no skill source names spec-context as the vocabulary file', () => {
    const offenders = markdownUnder(SKILLS)
      .filter((f) => /spec-context/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SKILLS.length));

    expect(offenders).toEqual([]);
  });

  it('the intent skill writes the glossary from its served template at the scope root', () => {
    const intent = readFileSync(join(SKILLS, 'intent', 'SKILL.md'), 'utf8');

    expect(intent).toContain('wiki://template/project/glossary');
    expect(intent).toContain('projects/<scope>/glossary.md');
    expect(intent).not.toContain('wiki://template/project/spec');
  });
});
