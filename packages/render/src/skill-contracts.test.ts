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

/** Shape lock for story-4-extension-dirs-hook-wiring slice 2: the Kiro step. */
describe('the wiki skill on Kiro', () => {
  const wiki = readFileSync(join(SKILLS, 'wiki', 'SKILL.md'), 'utf8');

  it('installs the power, writes the hook file from the template, and never copies skills or writes settings', () => {
    expect(wiki).toContain('dev.kiro/hooks/wiki-sdd.json.template');
    expect(wiki).toContain('~/.kiro/hooks/wiki-sdd.json');
    expect(wiki).toContain('{{PACKAGE_ROOT}}');
    expect(wiki).not.toMatch(/\.kiro\/skills\//);
    expect(wiki).not.toMatch(/writes? (to |into )?`?\.kiro\/settings/);
  });
});
