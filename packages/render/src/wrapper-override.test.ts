import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The override is claude chrome: hooks.json registers the front script, which
// delegates to the byte-shared wrapper beside it. Tests run the rendered
// claude copy — the render check pins it to plugins/src.
const HOOKS_DIR = fileURLToPath(new URL('../../../plugins/claude/wiki-sdd/hooks', import.meta.url));
const FRONT = join(HOOKS_DIR, 'claude-project-override.mjs');
const CODEX_HOOKS_DIR = fileURLToPath(
  new URL('../../../plugins/codex/wiki-sdd/hooks', import.meta.url)
);

interface Fixture {
  binDir: string;
  projectDir: string;
  home: string;
}

// Fake hook-capable kmd on PATH so the wrapper takes the in-process fast
// path and never reaches npx; it prints the argv the engine would parse.
function makeFixture(overrideContent?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wrapper-override-'));
  const kmdRoot = join(root, 'kmd-install');
  mkdirSync(join(kmdRoot, 'lib'), { recursive: true });
  mkdirSync(join(kmdRoot, 'bin'));
  writeFileSync(join(kmdRoot, 'package.json'), JSON.stringify({ name: 'kmd', version: '99.0.0' }));
  writeFileSync(
    join(kmdRoot, 'lib', 'kmd.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n'
  );
  symlinkSync(join('..', 'lib', 'kmd.mjs'), join(kmdRoot, 'bin', 'kmd'));
  const projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  if (overrideContent !== undefined) {
    writeFileSync(join(projectDir, '.claude', 'wiki-sdd.local.md'), overrideContent);
  }
  const home = join(root, 'home');
  mkdirSync(home);
  return { binDir: join(kmdRoot, 'bin'), projectDir, home };
}

// No kmd on PATH — the wrapper falls through to npx. The fake npx prints one
// arg per line and exits with FAKE_NPX_EXIT.
function makeNpxFixture(overrideContent?: string): Fixture {
  const fixture = makeFixture(overrideContent);
  const root = mkdtempSync(join(tmpdir(), 'wrapper-npx-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'npx'),
    `#!/bin/sh\nprintf '%s\\n' "$@"\nexit "\${FAKE_NPX_EXIT:-0}"\n`,
    {
      mode: 0o755
    }
  );
  return { ...fixture, binDir };
}

function runScript(script: string, fixture: Fixture, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [script, 'hook', 'prompt', '/original/vault'], {
    encoding: 'utf8',
    env: { PATH: fixture.binDir, HOME: fixture.home, ...env }
  });
  expect(result.status).toBe(0);
  return result;
}

function runWrapper(fixture: Fixture, env: Record<string, string>): string[] {
  const result = runScript(FRONT, fixture, env);
  return JSON.parse(result.stdout.trim()) as string[];
}

describe.skipIf(process.platform === 'win32')('project vault override', () => {
  it('replaces the vault-root positional from .claude/wiki-sdd.local.md', () => {
    const fixture = makeFixture('---\nvault_path: /override/vault\n---\n\nnotes\n');
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', '/override/vault']);
  });

  it('accepts a quoted value', () => {
    const fixture = makeFixture('---\nvault_path: "/quoted path/vault"\n---\n');
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', '/quoted path/vault']);
  });

  it('expands a leading tilde against HOME', () => {
    const fixture = makeFixture('---\nvault_path: ~/wiki/vault\n---\n');
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', join(fixture.home, 'wiki/vault')]);
  });

  it('keeps the configured root without CLAUDE_PROJECT_DIR', () => {
    const fixture = makeFixture('---\nvault_path: /override/vault\n---\n');
    const argv = runWrapper(fixture, {});
    expect(argv).toEqual(['hook', 'prompt', '/original/vault']);
  });

  it('keeps the configured root when the override file is absent', () => {
    const fixture = makeFixture();
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', '/original/vault']);
  });

  it('keeps the configured root on malformed frontmatter', () => {
    const fixture = makeFixture('---\nvault_path: /override/vault\n');
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', '/original/vault']);
  });

  it('keeps the configured root when the file lacks vault_path', () => {
    const fixture = makeFixture('---\nenabled: true\n---\n');
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', '/original/vault']);
  });

  it('rejects a relative vault_path', () => {
    const fixture = makeFixture('---\nvault_path: relative/vault\n---\n');
    const argv = runWrapper(fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(argv).toEqual(['hook', 'prompt', '/original/vault']);
  });

  it('exits 0 with a stderr diagnostic when delegation fails', () => {
    const fixture = makeFixture();
    const isolated = mkdtempSync(join(tmpdir(), 'wrapper-isolated-'));
    cpSync(FRONT, join(isolated, 'claude-project-override.mjs'));
    const result = runScript(join(isolated, 'claude-project-override.mjs'), fixture, {
      CLAUDE_PROJECT_DIR: fixture.projectDir
    });
    expect(result.stderr).toMatch(/delegation failed/);
  });
});

describe.skipIf(process.platform === 'win32')('npx fallback', () => {
  it('forwards the overridden argv to npx', () => {
    const fixture = makeNpxFixture('---\nvault_path: /override/vault\n---\n');
    const result = runScript(FRONT, fixture, { CLAUDE_PROJECT_DIR: fixture.projectDir });
    expect(result.stdout.trim().split('\n')).toEqual([
      '-y',
      '@bartolli/kmd@latest',
      'hook',
      'prompt',
      '/override/vault'
    ]);
  });

  it('degrades a nonzero npx exit to 0', () => {
    const fixture = makeNpxFixture();
    const result = runScript(FRONT, fixture, {
      CLAUDE_PROJECT_DIR: fixture.projectDir,
      FAKE_NPX_EXIT: '2'
    });
    expect(result.stderr).toMatch(/degrading open/);
  });
});

describe('hook registrations', () => {
  it('claude registers only the front script; codex never references it', () => {
    const claude = readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8');
    const codex = readFileSync(join(CODEX_HOOKS_DIR, 'hooks.json'), 'utf8');
    expect(claude).toContain('claude-project-override.mjs');
    expect(claude).not.toContain('run-kmd-hook.mjs');
    expect(codex).toContain('run-kmd-hook.mjs');
    expect(codex).not.toContain('claude-project-override.mjs');
  });
});
