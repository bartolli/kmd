import { describe, expect, it } from 'vitest';
import { resolveLinks } from './links.js';

const CANDIDATES = [
  'projects/alpha/spec/spec-shared.md',
  'projects/beta/spec/spec-shared.md',
  'projects/alpha/spec/spec-only.md',
  'projects/alpha/primer.md',
  'projects/beta/glossary.md',
  'research/topic/article.md'
];

const link = (source_path: string, target_path: string) => ({ source_path, target_path });

describe('resolveLinks', () => {
  it('resolves a canonical slug to its one owner', () => {
    expect(resolveLinks([link('notes/n.md', 'spec-only.md')], CANDIDATES)).toEqual([
      { source: 'notes/n.md', target: 'projects/alpha/spec/spec-only.md' }
    ]);
  });

  it('keeps an exact path as written', () => {
    const exact = 'projects/beta/spec/spec-shared.md';
    expect(resolveLinks([link('projects/alpha/a.md', exact)], CANDIDATES)).toEqual([
      { source: 'projects/alpha/a.md', target: exact }
    ]);
  });

  it('prefers the owner in the source page scope', () => {
    expect(resolveLinks([link('projects/beta/b.md', 'spec-shared.md')], CANDIDATES)).toEqual([
      { source: 'projects/beta/b.md', target: 'projects/beta/spec/spec-shared.md' }
    ]);
  });

  it('leaves a slug owned in several scopes, none local, unresolved', () => {
    expect(resolveLinks([link('research/topic/article.md', 'spec-shared.md')], CANDIDATES)).toEqual(
      []
    );
  });

  it('leaves a slug owned twice inside the source scope unresolved', () => {
    const candidates = [...CANDIDATES, 'projects/alpha/adr/spec-only.md'];
    expect(resolveLinks([link('projects/alpha/a.md', 'spec-only.md')], candidates)).toEqual([]);
  });

  it('lets a title-less local owner shadow an owner elsewhere', () => {
    const candidates = [...CANDIDATES, 'projects/beta/primer.md'];
    expect(resolveLinks([link('projects/alpha/a.md', 'primer.md')], candidates)).toEqual([
      { source: 'projects/alpha/a.md', target: 'projects/alpha/primer.md' }
    ]);
  });

  it('counts a slug and an exact path to the same page as one edge', () => {
    const links = [
      link('projects/alpha/a.md', 'spec-only.md'),
      link('projects/alpha/a.md', 'projects/alpha/spec/spec-only.md')
    ];
    expect(resolveLinks(links, CANDIDATES)).toEqual([
      { source: 'projects/alpha/a.md', target: 'projects/alpha/spec/spec-only.md' }
    ]);
  });

  it('drops a slug with no owner and a non-page target', () => {
    const links = [link('notes/n.md', 'missing.md'), link('notes/n.md', 'diagram.png')];
    expect(resolveLinks(links, CANDIDATES)).toEqual([]);
  });
});
