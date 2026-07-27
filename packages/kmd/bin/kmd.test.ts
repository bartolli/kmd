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
    repo: /kmd-e2e-demo-repo
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
    - id: retro-gate
      on: pretool
      enforce: block
      tool: Bash
      args_match: "git tag"
      reason: "Retro gate: no retro in scope newer than the last release note."
    - id: push-gate
      on: pretool
      enforce: block
      tool: Bash
      args_match: "git push"
      when:
        name: newer-than
        fresh: ["notes/demo-retro-*.md"]
        than: ["ops/release-*.md"]
      reason: "Retro gate: the retro is older than the last release note."
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runKmd(
  args: string[],
  stdin: string,
  kmdHome: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, KMD_HOME: kmdHome };
  delete env.WIKI_VAULT;
  delete env.WIKI_SCOPE;
  delete env.USER_PROMPT;
  Object.assign(env, extraEnv);
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

  it('reads the kiro-ide event from $USER_PROMPT, ignoring stdin', async () => {
    const result = await runKmd(
      ['hook', 'prompt', vaultRoot, '--scope', 'demo', '--harness', 'kiro-ide'],
      'not json — must never be read',
      kmdHome,
      { USER_PROMPT: "let's cut the release" }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Release protocol: retro gates the tag.\n');
  }, 30_000);

  it('falls back to the stdin event when kiro-ide has no $USER_PROMPT', async () => {
    const result = await runKmd(
      ['hook', 'prompt', vaultRoot, '--scope', 'demo', '--harness', 'kiro-ide'],
      promptEvent('s1', 'cut the release'),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Release protocol: retro gates the tag.\n');
  }, 30_000);

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

  it('denies a gated tool call through the binary (claude format)', async () => {
    const result = await runKmd(
      ['hook', 'pretool', vaultRoot, '--scope', 'demo', '--harness', 'claude'],
      JSON.stringify({
        session_id: 'e2e-pretool-1',
        tool_name: 'Bash',
        tool_input: { command: 'cd /repo && git tag v1.0.0' }
      }),
      kmdHome
    );

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Retro gate');
  }, 30_000);

  it('evaluates a newer-than gate through the binary', async () => {
    async function writePage(rel: string, updated: string): Promise<void> {
      const path = join(vaultRoot, rel);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `---\ntitle: p\nupdated: ${updated}\n---\nbody\n`);
    }
    const args = ['hook', 'pretool', vaultRoot, '--scope', 'demo', '--harness', 'claude'];
    const push = (session: string): string =>
      JSON.stringify({
        session_id: session,
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' }
      });

    await writePage('ops/release-1.md', '2026-07-20');
    await writePage('notes/demo-retro-1.md', '2026-07-10');
    const stale = await runKmd(args, push('e2e-when-1'), kmdHome);
    expect(stale.code).toBe(0);
    const parsed = JSON.parse(stale.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('older than');

    await writePage('notes/demo-retro-1.md', '2026-07-26');
    const fresh = await runKmd(args, push('e2e-when-2'), kmdHome);
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toBe('');
  }, 60_000);

  it('resolves the scope from the event cwd via scopes.*.repo', async () => {
    const inRepo = await runKmd(
      ['hook', 'prompt', vaultRoot],
      JSON.stringify({
        session_id: 'e2e-repo-1',
        prompt: "let's cut the release",
        cwd: '/kmd-e2e-demo-repo/src'
      }),
      kmdHome
    );
    expect(inRepo.code).toBe(0);
    expect(inRepo.stdout).toBe('Release protocol: retro gates the tag.\n');

    const outside = await runKmd(
      ['hook', 'prompt', vaultRoot],
      JSON.stringify({
        session_id: 'e2e-repo-2',
        prompt: "let's cut the release",
        cwd: '/somewhere/else'
      }),
      kmdHome
    );
    expect(outside.code).toBe(0);
    expect(outside.stdout).toBe('');
  }, 60_000);

  it('fires compiled --triggers file triggers without an active scope', async () => {
    const triggersFile = join(base, 'compiled-triggers.yaml');
    await writeFile(
      triggersFile,
      '- id: triage-skill\n  on: prompt\n  enforce: inject\n  keywords: [triage]\n  text: "Skill: /triage moves stories through the state machine."\n'
    );

    const result = await runKmd(
      ['hook', 'prompt', vaultRoot, '--triggers', triggersFile],
      promptEvent('e2e-skill-1', 'time to triage these findings'),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Skill: /triage moves stories through the state machine.\n');
  }, 30_000);

  it('fails open on a pretool event when vault.yaml is missing', async () => {
    const emptyRoot = join(base, 'no-vault');
    await mkdir(emptyRoot, { recursive: true });

    const result = await runKmd(
      ['hook', 'pretool', emptyRoot, '--scope', 'demo', '--harness', 'claude'],
      JSON.stringify({
        session_id: 'e2e-pretool-2',
        tool_name: 'Bash',
        tool_input: { command: 'git tag v2' }
      }),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('kmd hook:');
  }, 30_000);
});
