import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const KMD_ENTRY = fileURLToPath(new URL('./kmd.ts', import.meta.url));
// Absolute tsx entry: `--import tsx` resolves from the child cwd, which
// breaks tests that set cwd outside the workspace.
const TSX_ENTRY = createRequire(import.meta.url).resolve('tsx');

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
  extraEnv: NodeJS.ProcessEnv = {},
  cwd?: string
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, KMD_HOME: kmdHome };
  delete env.WIKI_VAULT;
  delete env.WIKI_SCOPE;
  delete env.USER_PROMPT;
  // deterministic project signal: the workspace cwd could sit under a
  // vault-carrying tree on a dev machine
  env.KMD_PROJECT_DIR = cwd ?? kmdHome;
  Object.assign(env, extraEnv);
  const promise = execFileAsync('node', ['--import', TSX_ENTRY, KMD_ENTRY, ...args], {
    env,
    timeout: 20_000,
    cwd
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

describe('kmd init (end-to-end)', () => {
  let base: string;
  let kmdHome: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-init-e2e-'));
    kmdHome = join(base, 'kmd-home');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('scaffolds a vault that kmd validate accepts', async () => {
    const target = join(base, 'fresh-vault');

    const init = await runKmd(['init', target], '', kmdHome);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(`kmd config set default_vault ${target}`);
    expect(init.stdout).toContain('kmd mcp');

    const validate = await runKmd(['validate', target], '', kmdHome);
    expect(validate.code).toBe(0);
  }, 30_000);

  it('refuses to scaffold over an existing vault, distinguished from generic non-empty', async () => {
    const target = join(base, 'fresh-vault');
    const first = await runKmd(['init', target], '', kmdHome);
    expect(first.code).toBe(0);

    const second = await runKmd(['init', target], '', kmdHome);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('already a vault');
    expect(second.stderr).toContain('vault.yaml exists');
  }, 30_000);

  it('scaffolds the current directory with -y when no dir is given', async () => {
    const target = join(base, 'cwd-vault');
    await mkdir(target, { recursive: true });

    const result = await runKmd(['init', '-y'], '', kmdHome, {}, target);
    expect(result.code).toBe(0);

    const validate = await runKmd(['validate', target], '', kmdHome);
    expect(validate.code).toBe(0);
  }, 30_000);

  it('keeps a missing target a loud usage error when stdin is not a TTY', async () => {
    const result = await runKmd(['init'], '', kmdHome);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage: kmd init <dir>');
  }, 30_000);
});

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

  it('degrades open on an unknown hook event', async () => {
    const result = await runKmd(
      ['hook', 'pretol', vaultRoot, '--scope', 'demo'],
      promptEvent('s1', "let's cut the release"),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('kmd hook:');
    expect(result.stderr).toContain('pretol');
  }, 30_000);

  it('keeps a missing hook event a loud usage error', async () => {
    const result = await runKmd(['hook'], '', kmdHome);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage: kmd hook <prompt|pretool|posttool|stop|session-start>');
    expect(result.stderr).not.toContain('unknown event');
  }, 30_000);

  it('degrades open on a command-position typo carrying a hook event', async () => {
    const result = await runKmd(
      ['hok', 'prompt', vaultRoot, '--scope', 'demo'],
      promptEvent('s1', "let's cut the release"),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('unknown command: hok');
  }, 30_000);

  it('keeps a plain command typo a loud usage error', async () => {
    const result = await runKmd(['valdate'], '', kmdHome);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown command: valdate');
    expect(result.stderr).toContain('usage: kmd <command>');
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

  it('posttool: validates and syncs quietly after a clean vault write', async () => {
    const page = join(vaultRoot, 'notes', 'demo-note.md');
    await mkdir(join(vaultRoot, 'notes'), { recursive: true });
    await writeFile(
      page,
      '---\ntitle: Demo note\ntags: [governance]\nupdated: 2026-07-27\n---\nBody.\n'
    );

    const result = await runKmd(
      ['hook', 'posttool', vaultRoot, '--harness', 'claude'],
      JSON.stringify({
        session_id: 'e2e-post-1',
        tool_name: 'Write',
        tool_input: { file_path: page }
      }),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(kmdHome, 'db'))).toBe(true);
  }, 30_000);

  it('posttool: blocks with the fix list and holds sync on validation errors', async () => {
    const page = join(vaultRoot, 'notes', 'bad-note.md');
    await mkdir(join(vaultRoot, 'notes'), { recursive: true });
    await writeFile(page, '---\ntitle: Bad\nkind: bogus\ntags: [governance]\n---\nBody.\n');

    const result = await runKmd(
      ['hook', 'posttool', vaultRoot, '--harness', 'claude'],
      JSON.stringify({
        session_id: 'e2e-post-2',
        tool_name: 'Write',
        tool_input: { file_path: page }
      }),
      kmdHome
    );

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('kind-vocabulary');
    expect(existsSync(join(kmdHome, 'db'))).toBe(false);
  }, 30_000);

  it('posttool: ignores writes outside the vault root', async () => {
    const result = await runKmd(
      ['hook', 'posttool', vaultRoot, '--harness', 'claude'],
      JSON.stringify({
        session_id: 'e2e-post-3',
        tool_name: 'Write',
        tool_input: { file_path: join(base, 'elsewhere', 'code.ts') }
      }),
      kmdHome
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(existsSync(join(kmdHome, 'db'))).toBe(false);
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

describe('two-tier resolution (end-to-end)', () => {
  let base: string;
  let kmdHome: string;

  beforeEach(async () => {
    // realpath: resolution canonicalizes, and macOS tmpdir is a symlink
    base = realpathSync(await mkdtemp(join(tmpdir(), 'kmd-tier-e2e-')));
    kmdHome = join(base, 'kmd-home');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('rejects a positional combined with --default-root', async () => {
    const result = await runKmd(['mcp', '/some/vault', '--default-root', '/other'], '', kmdHome);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('init --local scaffolds the project tier and config resolves it', async () => {
    const project = join(base, 'project');
    await mkdir(project, { recursive: true });

    const init = await runKmd(['init', '--local', '-y'], '', kmdHome, {}, project);
    expect(init.code).toBe(0);
    expect(existsSync(join(project, 'vault', 'vault.yaml'))).toBe(true);
    const gitignore = join(project, '.kmd', '.gitignore');
    expect(existsSync(gitignore)).toBe(true);

    const config = await runKmd(['config'], '', kmdHome, {}, project);
    expect(config.code).toBe(0);
    expect(config.stdout).toContain(join(project, 'vault'));
    expect(config.stdout).toContain('source: project tier (convention)');
    expect(config.stdout).toContain(join(project, '.kmd', 'db', 'index.db'));
  }, 30_000);

  it('a foreign ancestor vault.yaml does not capture env resolution', async () => {
    const envVault = join(base, 'env-vault');
    const init = await runKmd(['init', envVault], '', kmdHome);
    expect(init.code).toBe(0);
    const foreign = join(base, 'foreign');
    const sub = join(foreign, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(join(foreign, 'vault.yaml'), 'not_a_kmd_vault: true\n');

    const config = await runKmd(['config'], '', kmdHome, { WIKI_VAULT: envVault }, sub);
    expect(config.code).toBe(0);
    expect(config.stdout).toContain(`vault: ${envVault}`);
    expect(config.stdout).toContain('source: $WIKI_VAULT');
    expect(config.stderr).toContain(`ignoring ${join(foreign, 'vault.yaml')}`);
    expect(config.stderr).toContain('.kmd marker');
  }, 30_000);

  it('init -y never touches default_vault; --set-default records it', async () => {
    const scratch = join(base, 'scratch-vault');
    const init = await runKmd(['init', scratch, '-y'], '', kmdHome);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(`kmd config set default_vault ${scratch}`);

    const unset = await runKmd(['config', 'get', 'default_vault'], '', kmdHome);
    expect(unset.code).toBe(1);
    expect(unset.stdout).toBe('');

    const chosen = join(base, 'chosen-vault');
    const initSet = await runKmd(['init', chosen, '--set-default'], '', kmdHome);
    expect(initSet.code).toBe(0);
    expect(initSet.stdout).toContain(`default_vault: ${chosen}`);

    const get = await runKmd(['config', 'get', 'default_vault'], '', kmdHome);
    expect(get.code).toBe(0);
    expect(get.stdout.trim()).toBe(chosen);
  }, 30_000);

  it('rejects --set-default on init --local', async () => {
    const project = join(base, 'local-project');
    await mkdir(project, { recursive: true });

    const result = await runKmd(
      ['init', '--local', '-y', '--set-default'],
      '',
      kmdHome,
      {},
      project
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--set-default applies to global init only');
  }, 30_000);

  it('config set/get default_vault round-trips and resolves outside projects', async () => {
    const vault = join(base, 'global-vault');
    const init = await runKmd(['init', vault], '', kmdHome);
    expect(init.code).toBe(0);
    const neutral = join(base, 'neutral');
    await mkdir(neutral, { recursive: true });

    const set = await runKmd(['config', 'set', 'default_vault', vault], '', kmdHome, {}, neutral);
    expect(set.code).toBe(0);
    expect(existsSync(join(kmdHome, 'config.yaml'))).toBe(true);

    const get = await runKmd(['config', 'get', 'default_vault'], '', kmdHome, {}, neutral);
    expect(get.code).toBe(0);
    expect(get.stdout.trim()).toBe(vault);

    const config = await runKmd(['config'], '', kmdHome, {}, neutral);
    expect(config.stdout).toContain(`vault: ${vault}`);
    expect(config.stdout).toContain('source: global config (default_vault)');

    const unset = await runKmd(['config', 'unset', 'default_vault'], '', kmdHome, {}, neutral);
    expect(unset.code).toBe(0);
  }, 30_000);
});
