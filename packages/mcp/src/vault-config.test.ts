import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVaultConfig } from './vault-config.js';

const BIN_ENTRY = fileURLToPath(new URL('../bin/stdio.ts', import.meta.url));

function runStartup(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // stdin = /dev/null so the stdio transport sees EOF and can't block the test.
    const child = spawn('node', ['--import', 'tsx', BIN_ENTRY], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const VALID =
  'scopes:\n  sotto:\n    status: active\n  codanna:\n    methodology: tdd\n    status: active\n' +
  'kinds: [spec, adr, story, note]\n' +
  'statuses: [draft, active, superseded, archived]\n' +
  'methodologies: [sdd, tdd, hybrid]\n' +
  'tags:\n  canonical: [mcp]\n  aliases:\n    model-context-protocol: mcp\n';

describe('loadVaultConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiki-mcp-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a valid vault.yaml and returns its vocabulary', async () => {
    await writeFile(join(dir, 'vault.yaml'), VALID);

    const config = await loadVaultConfig(dir);

    expect(Object.keys(config.scopes).sort()).toEqual(['codanna', 'sotto']);
    expect(config.kinds).toContain('story');
    expect(config.tags.aliases['model-context-protocol']).toBe('mcp');
  });

  it('is vault-agnostic — one loader yields each vault its own vocabulary', async () => {
    const other = await mkdtemp(join(tmpdir(), 'wiki-mcp-config-other-'));
    try {
      await writeFile(join(dir, 'vault.yaml'), VALID);
      await writeFile(
        join(other, 'vault.yaml'),
        'scopes:\n  elsewhere:\n    status: active\n' +
          'kinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\n' +
          'tags:\n  canonical: []\n  aliases: {}\n'
      );

      const a = await loadVaultConfig(dir);
      const b = await loadVaultConfig(other);

      expect(Object.keys(a.scopes)).toContain('sotto');
      expect(Object.keys(b.scopes)).toEqual(['elsewhere']);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('throws fail-loud when vault.yaml is absent', async () => {
    await expect(loadVaultConfig(dir)).rejects.toThrow(/vault\.yaml not found/);
  });

  it('throws when vault.yaml violates the schema', async () => {
    // `sotto` is missing the required `status` field.
    await writeFile(join(dir, 'vault.yaml'), 'scopes:\n  sotto:\n    methodology: tdd\n');

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });
});

describe('wiki-mcp startup', () => {
  it('fails loud when vault.yaml is absent, before any DB access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-mcp-startup-'));
    // WIKI_VAULT has no vault.yaml; WIKI_DB is a fake string the pool never uses,
    // because loadVaultConfig must throw before createPool.
    const env = {
      ...process.env,
      WIKI_VAULT: dir,
      WIKI_DB: 'postgresql://invalid/nonexistent',
      LOG_LEVEL: 'silent'
    };
    try {
      const { code, stderr } = await runStartup(env);

      expect(code).not.toBe(0);
      expect(stderr).toContain('vault.yaml not found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
