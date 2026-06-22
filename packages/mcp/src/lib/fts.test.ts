import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from './fts.js';

describe('sanitizeFtsQuery', () => {
  it('passes plain words through', () => {
    expect(sanitizeFtsQuery('authentication PKCE')).toBe('authentication PKCE');
  });

  it('strips dots (file extensions)', () => {
    expect(sanitizeFtsQuery('CLAUDE.md pedagogy')).toBe('CLAUDE md pedagogy');
  });

  it('strips slashes and symbols', () => {
    expect(sanitizeFtsQuery('path/to/file.ts @scope +required')).toBe('path to file ts scope required');
  });

  it('strips FTS5 metacharacters', () => {
    expect(sanitizeFtsQuery('"exact" (grouped) col:filter ^initial')).toBe('exact grouped col filter initial');
  });

  it('removes FTS5 boolean keywords', () => {
    expect(sanitizeFtsQuery('foo AND bar OR baz NOT qux NEAR end')).toBe('foo bar baz qux end');
  });

  it('preserves unicode letters', () => {
    expect(sanitizeFtsQuery('naïve café résumé')).toBe('naïve café résumé');
  });

  it('splits underscores (matches unicode61 tokenizer)', () => {
    expect(sanitizeFtsQuery('my_function snake_case')).toBe('my function snake case');
  });

  it('returns empty string for all-keyword input', () => {
    expect(sanitizeFtsQuery('AND OR NOT')).toBe('');
  });

  it('returns empty string for all-punctuation input', () => {
    expect(sanitizeFtsQuery('... --- ***')).toBe('');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeFtsQuery('  spaced   out  ')).toBe('spaced out');
  });
});
