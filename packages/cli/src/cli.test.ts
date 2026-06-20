import { describe, expect, it } from 'vitest';
import { resolveCli } from './cli.js';

describe('resolveCli', () => {
  it('routes `sync` to the sync command', () => {
    expect(resolveCli(['sync'])).toEqual({ kind: 'run', command: 'sync' });
  });

  it('routes `validate` to the validate command', () => {
    expect(resolveCli(['validate'])).toEqual({ kind: 'run', command: 'validate' });
  });

  it('errors when no command is given', () => {
    expect(resolveCli([]).kind).toBe('error');
  });

  it('errors on an unknown command', () => {
    expect(resolveCli(['bogus']).kind).toBe('error');
  });
});
