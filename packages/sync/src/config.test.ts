import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVaultConfig } from './config.js';

describe('loadVaultConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiki-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a valid vault.yaml and returns its scopes', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n  codanna:\n    methodology: tdd\n    status: active\n'
    );

    const config = await loadVaultConfig(dir);

    expect(Object.keys(config.scopes).sort()).toEqual(['codanna', 'sotto']);
  });

  it('throws when vault.yaml violates the schema', async () => {
    // `sotto` is missing the required `status` field.
    await writeFile(join(dir, 'vault.yaml'), 'scopes:\n  sotto:\n    methodology: tdd\n');

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('throws when vault.yaml is absent', async () => {
    await expect(loadVaultConfig(dir)).rejects.toThrow(/not found/);
  });
});
