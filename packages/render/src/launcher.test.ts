import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The Package's launcher is what a conformant client runs from mcp.json with
// only PLUGIN_ROOT and PLUGIN_DATA in the environment. Fixtures build a PATH
// out of a fake npm-shaped install, a pnpm-shaped shim, and a stub npx, and
// read back which tier ran and what it received.

const LAUNCHER = fileURLToPath(
  new URL('../../../plugins/src/wiki-sdd/scripts/run-kmd.mjs', import.meta.url)
);
const WRAPPER = fileURLToPath(
  new URL('../../../plugins/src/wiki-sdd/hooks/run-kmd-hook.mjs', import.meta.url)
);

const CURRENT = '0.16.0';
const STALE = '0.6.0';

let base: string;
let marker: string;

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// npm's global layout: bin/kmd -> ../lib/node_modules/@bartolli/kmd/dist/kmd.mjs.
// The entry runs inside the launcher's process and records argv and env.
function npmInstall(name: string, version: string): string {
  const root = join(base, name);
  const pkg = join(root, 'lib', 'node_modules', '@bartolli', 'kmd');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@bartolli/kmd', version }));
  writeFileSync(
    join(pkg, 'dist', 'kmd.mjs'),
    `import { appendFileSync, writeFileSync } from 'node:fs';
const m = process.env.MARKER;
writeFileSync(m + '.args', process.argv.slice(2).join(' ') + '\\n');
writeFileSync(m + '.env', JSON.stringify(process.env));
appendFileSync(m, 'import\\n');
`
  );
  symlinkSync('../lib/node_modules/@bartolli/kmd/dist/kmd.mjs', join(root, 'bin', 'kmd'));
  return join(root, 'bin');
}

// A pnpm-shaped shim: a POSIX script, no extension, no package.json above it.
// --version answers without touching stdin; a run records its args.
function shim(name: string, version: string, opts: { exit?: number } = {}): string {
  const dir = join(base, name);
  mkdirSync(dir);
  executable(
    join(dir, 'kmd'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo probe >> "$MARKER"; echo ${version}; exit 0; fi
printf '%s\\n' "$*" > "$MARKER.args"
echo shim >> "$MARKER"
exit ${opts.exit ?? 0}
`
  );
  return dir;
}

// Shadows any real npx on the machine: the launcher spawns `npx` by name, and
// a real one would reach the registry.
function stubNpx(): string {
  const dir = join(base, 'npx-stub');
  mkdirSync(dir);
  executable(
    join(dir, 'npx'),
    `#!/bin/sh
printf '%s\\n' "$*" > "$MARKER.npx-args"
echo npx >> "$MARKER"
exit 0
`
  );
  return dir;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], dirs: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: { PATH: [...dirs, '/bin', '/usr/bin'].join(':'), MARKER: marker, HOME: base, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

function tiers(): string[] {
  return existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
}

function recorded(suffix: string): string | null {
  const path = `${marker}${suffix}`;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kmd-launcher-'));
  marker = join(base, 'marker');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the launcher resolves a global kmd', () => {
  it('runs the mcp server root-free from a current global install', async () => {
    const r = await run(['mcp'], [npmInstall('npm', CURRENT)], {
      PLUGIN_ROOT: join(base, 'pkg'),
      PLUGIN_DATA: join(base, 'data')
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(tiers()).toEqual(['import']);
    expect(recorded('.args')).toBe('mcp\n');
    const env = JSON.parse(recorded('.env') ?? '{}') as Record<string, string>;
    expect(env.WIKI_VAULT).toBeUndefined();
    expect(env.PLUGIN_ROOT).toBe(join(base, 'pkg'));
  });

  it('falls back to npx below the floor, naming the stale version', async () => {
    const r = await run(['mcp'], [stubNpx(), shim('pnpm', STALE)]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'npx']);
    expect(r.stderr).toContain(`kmd ${STALE}, below ${CURRENT}`);
    expect(recorded('.npx-args')).toBe('-y @bartolli/kmd@latest mcp\n');
  });

  it('reports on stderr and fails the start when neither kmd nor npx is on PATH', async () => {
    mkdirSync(join(base, 'empty'));
    const r = await run(['mcp'], [], { PATH: join(base, 'empty') });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toEqual([
      expect.stringMatching(
        /^kmd launcher: no kmd at or above 0\.16\.0 on PATH, and npx failed to start/
      )
    ]);
    expect(tiers()).toEqual([]);
  });

  it('exits 0 on a hook run whatever happens — a launcher failure never blocks a harness event', async () => {
    const crashed = await run(
      ['hook', 'pretool', '--harness', 'kiro'],
      [shim('pnpm', CURRENT, { exit: 3 })]
    );
    expect(crashed.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'shim']);
    expect(recorded('.args')).toBe('hook pretool --harness kiro\n');
    expect(crashed.stderr).toContain('exited 3 — degrading open');

    mkdirSync(join(base, 'empty'));
    const dark = await run(['hook', 'prompt'], [], { PATH: join(base, 'empty') });
    expect(dark.code).toBe(0);
    expect(dark.stderr).toContain('npx failed to start');
  });

  it('declares the same floor as the hook wrapper', () => {
    const declared = (file: string, name: string): string | undefined =>
      new RegExp(`${name} = \\[(\\d+), (\\d+), (\\d+)\\]`)
        .exec(readFileSync(file, 'utf8'))
        ?.slice(1)
        .join('.');
    expect(declared(LAUNCHER, 'MIN_KMD_VERSION')).toBe(CURRENT);
    expect(declared(WRAPPER, 'MIN_HOOK_VERSION')).toBe(CURRENT);
  });
});
