import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDatabase, resolveIndexPath, setMeta } from '@llm-wiki/db/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCli, runConfig, runDbReset } from './cli.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('../bin/wiki.ts', import.meta.url));

async function makeInvalidVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-sync-gate-'));
  await writeFile(
    join(dir, 'vault.yaml'),
    'scopes:\n  sotto:\n    status: active\nkinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\ntags:\n  canonical: []\n  aliases: {}\n'
  );
  const specDir = join(dir, 'projects', 'sotto', 'spec');
  await mkdir(specDir, { recursive: true });
  // An unquoted `Status: Preview` scalar makes the YAML parser throw — the live
  // bug that silently halts sync mid-walk.
  await writeFile(
    join(specDir, 'spec-x.md'),
    '---\ntitle: X\nsummary: Status: Preview\n---\nbody\n'
  );
  return dir;
}

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

describe('kmd config / db reset (per-vault index)', () => {
  let kmdHome: string;
  let vaultA: string;
  let vaultB: string;
  const savedEnv = { KMD_HOME: process.env.KMD_HOME, WIKI_VAULT: process.env.WIKI_VAULT };

  beforeEach(async () => {
    kmdHome = await mkdtemp(join(tmpdir(), 'kmd-home-'));
    vaultA = await mkdtemp(join(tmpdir(), 'kmd-cfg-vault-a-'));
    vaultB = await mkdtemp(join(tmpdir(), 'kmd-cfg-vault-b-'));
    process.env.KMD_HOME = kmdHome;
    delete process.env.WIKI_VAULT;
  });

  afterEach(async () => {
    process.env.KMD_HOME = savedEnv.KMD_HOME;
    process.env.WIKI_VAULT = savedEnv.WIKI_VAULT;
    if (savedEnv.KMD_HOME === undefined) delete process.env.KMD_HOME;
    if (savedEnv.WIKI_VAULT === undefined) delete process.env.WIKI_VAULT;
    for (const dir of [kmdHome, vaultA, vaultB]) {
      await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function seedVaultIndex(vault: string, synced: string): Promise<string> {
    const dbPath = resolveIndexPath(vault);
    await mkdir(dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    setMeta(db, 'vault_root', vault);
    setMeta(db, 'last_synced', synced);
    db.close();
    return dbPath;
  }

  it('resolved mode: prints vault, per-vault index path, and sync time', async () => {
    await seedVaultIndex(vaultA, '2026-07-06T00:00:00.000Z');
    process.env.WIKI_VAULT = vaultA;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfig();

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain(`index: ${resolveIndexPath(vaultA)}`);
    expect(out).toContain('synced: 2026-07-06T00:00:00.000Z');
    expect(out).toMatch(/vault: .*kmd-cfg-vault-a-/);
  });

  it('list mode: enumerates every known vault from index metas', async () => {
    await seedVaultIndex(vaultA, '2026-07-01T00:00:00.000Z');
    await seedVaultIndex(vaultB, '2026-07-02T00:00:00.000Z');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfig();

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain(vaultA);
    expect(out).toContain(vaultB);
    expect(out.match(/vault: /g)).toHaveLength(2);
  });

  it('config never creates index state for a merely-asked-about vault', async () => {
    process.env.WIKI_VAULT = vaultA;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfig();

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('synced: never');
    expect(existsSync(dirname(resolveIndexPath(vaultA)))).toBe(false);
  });

  it("db reset removes exactly the resolved vault's index directory", async () => {
    await seedVaultIndex(vaultA, 'x');
    await seedVaultIndex(vaultB, 'x');
    process.env.WIKI_VAULT = vaultA;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDbReset();

    expect(existsSync(dirname(resolveIndexPath(vaultA)))).toBe(false);
    expect(existsSync(resolveIndexPath(vaultB))).toBe(true);
  });
});

describe('wiki sync pre-sync gate', () => {
  it('aborts with validation output and a non-zero exit, before any DB access', async () => {
    const dir = await makeInvalidVault();
    // WIKI_DB is blanked, not real: if the gate were ever removed, sync would still
    // abort (on the env check) without touching a database — so the validation
    // output the assertions pin can only come from the gate firing first.
    const env = { ...process.env, WIKI_VAULT: dir, WIKI_DB: '' };
    try {
      const result = await execFileAsync('node', ['--import', 'tsx', CLI_ENTRY, 'sync'], {
        env
      }).then(
        () => ({ code: 0, stderr: '' }),
        (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 0, stderr: e.stderr ?? '' })
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('frontmatter-parse');
      expect(result.stderr).toContain('sync aborted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
