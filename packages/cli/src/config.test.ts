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
      'scopes:\n  sotto:\n    status: active\n  codanna:\n    methodology: tdd\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd, tdd, hybrid]\n' +
        'tags:\n  canonical: [mcp]\n  aliases: {}\n'
    );

    const config = await loadVaultConfig(dir);

    expect(Object.keys(config.scopes).sort()).toEqual(['codanna', 'sotto']);
  });

  it('returns the controlled vocabulary lists', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec, adr, story, note]\n' +
        'statuses: [draft, active, superseded, archived]\n' +
        'methodologies: [sdd, tdd, hybrid]\n' +
        'tags:\n  canonical: [mcp]\n  aliases: {}\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.kinds).toContain('story');
    expect(config.statuses).toContain('archived');
    expect(config.methodologies).toEqual(['sdd', 'tdd', 'hybrid']);
  });

  it('returns canonical tags and their aliases', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: [mcp, fifo]\n  aliases:\n    model-context-protocol: mcp\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.tags.canonical).toContain('mcp');
    expect(config.tags.aliases['model-context-protocol']).toBe('mcp');
  });

  it('throws when vault.yaml violates the schema', async () => {
    // `sotto` is missing the required `status` field.
    await writeFile(join(dir, 'vault.yaml'), 'scopes:\n  sotto:\n    methodology: tdd\n');

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('throws when a required vocabulary section is missing', async () => {
    // `tags` is required — an incomplete config is not a single source of truth.
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('throws when vault.yaml is absent', async () => {
    await expect(loadVaultConfig(dir)).rejects.toThrow(/not found/);
  });
});
