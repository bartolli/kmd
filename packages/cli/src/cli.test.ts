import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveCli } from './cli.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url));

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
