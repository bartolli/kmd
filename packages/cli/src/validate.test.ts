import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasErrors, validatePage, validateVault } from './validate.js';

describe('validatePage', () => {
  it('flags frontmatter that fails to parse (unquoted colon)', () => {
    // `summary: Status: Preview` — an unquoted `Word: phrase` scalar makes the
    // YAML parser throw; this is the live bug that silently halts sync mid-walk.
    const raw = '---\ntitle: X\nsummary: Status: Preview\n---\nbody\n';

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('frontmatter-parse');
    expect(findings[0]?.severity).toBe('error');
  });

  it('returns no findings for a well-formed page', () => {
    const raw = '---\ntitle: X\nkind: spec\n---\nbody\n';

    expect(validatePage('projects/sotto/spec/spec-x.md', raw)).toEqual([]);
  });
});

describe('validateVault', () => {
  it('reports a malformed page found by walking the vault', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-validate-'));
    try {
      const specDir = join(dir, 'projects', 'sotto', 'spec');
      await mkdir(specDir, { recursive: true });
      await writeFile(
        join(specDir, 'spec-x.md'),
        '---\ntitle: X\nsummary: Status: Preview\n---\nbody\n'
      );

      const findings = await validateVault(dir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('projects/sotto/spec/spec-x.md');
      expect(findings[0]?.rule).toBe('frontmatter-parse');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('hasErrors', () => {
  it('is true only when a finding has error severity', () => {
    expect(hasErrors([{ path: 'p', rule: 'r', severity: 'error', message: 'm' }])).toBe(true);
    expect(hasErrors([{ path: 'p', rule: 'r', severity: 'warning', message: 'm' }])).toBe(false);
    expect(hasErrors([])).toBe(false);
  });
});
