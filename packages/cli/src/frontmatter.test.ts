import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits frontmatter data from body', () => {
    const result = parseFrontmatter('---\ntitle: X\n---\nbody line\n');

    expect(result.data).toEqual({ title: 'X' });
    expect(result.content).toBe('body line\n');
  });

  it('throws on invalid YAML frontmatter', () => {
    expect(() =>
      parseFrontmatter('---\ntitle: X\nsummary: Status: Preview\n---\nbody\n')
    ).toThrow();
  });

  it('returns empty data and whole input when there is no frontmatter', () => {
    expect(parseFrontmatter('just body\nmore\n')).toEqual({
      data: {},
      content: 'just body\nmore\n'
    });
  });

  it('treats an empty frontmatter block as empty data', () => {
    expect(parseFrontmatter('---\n---\nbody\n')).toEqual({ data: {}, content: 'body\n' });
  });

  it('only consumes the leading block, leaving `---` in the body intact', () => {
    const result = parseFrontmatter('---\ntitle: X\n---\nintro\n\n---\n\nafter\n');

    expect(result.data).toEqual({ title: 'X' });
    expect(result.content).toBe('intro\n\n---\n\nafter\n');
  });
});
