import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits the leading --- block from the body', () => {
    const { data, content } = parseFrontmatter('---\ntitle: X\nphase: 2\n---\nbody text\n');

    expect(data.title).toBe('X');
    expect(data.phase).toBe(2);
    expect(content).toBe('body text\n');
  });

  it('returns empty data and the whole input when there is no frontmatter', () => {
    const { data, content } = parseFrontmatter('# Just a heading\n');

    expect(data).toEqual({});
    expect(content).toBe('# Just a heading\n');
  });
});
