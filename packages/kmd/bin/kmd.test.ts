import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const KMD_ENTRY = fileURLToPath(new URL('./kmd.ts', import.meta.url));

const VAULT_YAML = `scopes:
  demo:
    status: active
kinds: [spec]
statuses: [active]
methodologies: [sdd]
tags:
  canonical: []
  aliases: {}
triggers_extra:
  demo:
    - id: release-protocol
      on: prompt
      enforce: inject
      keywords: [release]
      text: "Release protocol: retro gates the tag."
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runKmd(args: string[], stdin: string, kmdHome: string): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, KMD_HOME: kmdHome };
  delete env.WIKI_VAULT;
  delete env.WIKI_SCOPE;
  const promise = execFileAsync('node', ['--import', 'tsx', KMD_ENTRY, ...args], {
    env,
    timeout: 20_000
  });
  promise.child.stdin?.on('error', () => {});
  promise.child.stdin?.write(stdin);
  promise.child.stdin?.end();
  return promise.then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: Error & { code?: number; stdout?: string; stderr?: string }) => ({
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? ''
    })
  );
}

function promptEvent(sessionId: string, prompt: string): string {
  return JSON.stringify({ session_id: sessionId, prompt, cwd: '/tmp' });
}

describe('kmd hook prompt (end-to-end)', () => {
  let base: string;
  let vaultRoot: string;
  let kmdHome: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-hook-e2e-'));
    vaultRoot = join(base, 'vault');
    kmdHome = join(base, 'kmd-home');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(join(vaultRoot, 'vault.yaml'), VAULT_YAML);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('injects on keyword match, dedups per session, refires for a new session', async () => {
    const args = ['hook', 'prompt', vaultRoot, '--scope', 'demo'];

    const first = await runKmd(args, promptEvent('s1', "let's cut the release"), kmdHome);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('Release protocol: retro gates the tag.\n');

    const repeat = await runKmd(args, promptEvent('s1', 'release it again'), kmdHome);
    expect(repeat.code).toBe(0);
    expect(repeat.stdout).toBe('');

    const other = await runKmd(args, promptEvent('s2', 'releasing now'), kmdHome);
    expect(other.code).toBe(0);
    expect(other.stdout).toBe('Release protocol: retro gates the tag.\n');
  }, 60_000);

  it('stays silent on a non-matching prompt', async () => {
    const result = await runKmd(
      ['hook', 'prompt', vaultRoot, '--scope', 'demo'],
      promptEvent('s1', 'nothing relevant here'),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  }, 30_000);

  it('degrades to a silent no-op when vault.yaml is missing', async () => {
    const emptyRoot = join(base, 'no-vault');
    await mkdir(emptyRoot, { recursive: true });

    const result = await runKmd(
      ['hook', 'prompt', emptyRoot, '--scope', 'demo'],
      promptEvent('s1', 'cut the release'),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('kmd hook:');
  }, 30_000);

  it('rejects an unknown hook event loudly', async () => {
    const result = await runKmd(['hook', 'nope'], '', kmdHome);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown hook event: nope');
  }, 30_000);
});
