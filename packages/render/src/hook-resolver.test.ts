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
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The resolver wrappers are the one piece of plugin chrome that executes on
// every hook event, and their PATH scan is what silently disabled the gates
// on shim installs: a pnpm or Volta `kmd` is executable but not importable.
// Each case builds a PATH out of fixtures — a marker shim that answers
// --version, a pnpm-shaped shim with a cmd-shim trailer, a fake npm-shaped
// install with or without a build stamp, a stub npx that shadows any real one —
// and reads back which tier ran, with the payload and args it received.

// The Package launcher is the shared wrapper: the claude and codex flavors
// carry a copy of it at hooks/run-kmd-hook.mjs. Coco keeps its own npx-free
// resolver in its extension dir.
const SHARED = fileURLToPath(
  new URL('../../../plugins/src/wiki-sdd/scripts/run-kmd.mjs', import.meta.url)
);
const COCO = fileURLToPath(
  new URL('../../../plugins/src/wiki-sdd/com.snowflake.cortex/run-kmd-hook.mjs', import.meta.url)
);

const FLOOR_DECL = /MIN_KMD_VERSION = \[(\d+), (\d+), (\d+)\]/;
const COCO_FLOOR_DECL = /MIN_HOOK_VERSION = \[(\d+), (\d+), (\d+)\]/;
const floor = FLOOR_DECL.exec(readFileSync(SHARED, 'utf8'));
if (floor === null) throw new Error('the launcher declares no MIN_KMD_VERSION');
const CURRENT = `${floor[1]}.${floor[2]}.${floor[3]}`;
// hook-capable, below every floor since: the class the exit code cannot catch
const STALE = '0.6.0';
const PAYLOAD = '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}\n';
const HOOK_ARGS = ['hook', 'pretool', '--harness', 'claude'];
const DENY = '{"decision":"deny","reason":"fixture"}';

let base: string;
let marker: string;
let npxDir: string;

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// A pnpm-shaped shim: a POSIX script, no extension, no package.json above it.
// --version answers without touching stdin; a hook run records its args,
// forwards stdin to the marker, then speaks the deny contract.
function shim(
  name: string,
  version: string,
  opts: { exit?: number; answersVersion?: boolean } = {}
): string {
  const dir = join(base, name);
  mkdirSync(dir);
  const onVersion =
    opts.answersVersion === false
      ? 'echo "unknown option" >&2; exit 1'
      : `echo probe >> "$MARKER"; echo ${version}; exit 0`;
  executable(
    join(dir, 'kmd'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then ${onVersion}; fi
printf '%s\\n' "$*" > "$MARKER.args"
cat > "$MARKER.stdin"
echo shim >> "$MARKER"
echo '${DENY}'
exit ${opts.exit ?? 0}
`
  );
  return dir;
}

function installedEntry(name: string): string {
  return join(base, name, 'lib', 'node_modules', '@bartolli', 'kmd', 'dist', 'kmd.mjs');
}

// npm's global layout: bin/kmd -> ../lib/node_modules/@bartolli/kmd/dist/kmd.mjs
// with package.json one level above dist. The entry runs inside the wrapper's
// process, so it sees the wrapper's stdin and the argv the wrapper rewrote.
// `stamp` is the build's `kmd-version=` banner; omitted for pre-stamp bundles.
function npmInstall(name: string, version: string | null, opts: { stamp?: string } = {}): string {
  const root = join(base, name);
  const pkg = join(root, 'lib', 'node_modules', '@bartolli', 'kmd');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  if (version !== null) {
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@bartolli/kmd', version }));
  }
  const banner =
    opts.stamp === undefined ? '' : `#!/usr/bin/env node\n// kmd-version=${opts.stamp}\n`;
  writeFileSync(
    installedEntry(name),
    `${banner}import { appendFileSync, writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const m = process.env.MARKER;
writeFileSync(m + '.args', process.argv.slice(2).join(' ') + '\\n');
writeFileSync(m + '.stdin', input);
appendFileSync(m, 'import\\n');
console.log('${DENY}');
`
  );
  symlinkSync('../lib/node_modules/@bartolli/kmd/dist/kmd.mjs', join(root, 'bin', 'kmd'));
  return join(root, 'bin');
}

// pnpm's real shim shape: a POSIX script that execs node on its target and
// ends in the cmd-shim trailer naming that target. Markers record a probe or
// a spawn, either of which means the wrapper failed to read the trailer.
function pnpmShim(name: string, target: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  executable(
    join(dir, 'kmd'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo probe >> "$MARKER"; fi
echo shim >> "$MARKER"
exec node "${target}" "$@"
# cmd-shim-target=${target}
`
  );
  return dir;
}

// pnpm 10's shim: no trailer; the target appears only in cmd-shim's exec
// line, relative to $basedir.
function pnpm10Shim(name: string, target: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  const rel = relative(dir, target);
  executable(
    join(dir, 'kmd'),
    `#!/bin/sh
basedir=$(dirname "$0")
if [ "$1" = "--version" ]; then echo probe >> "$MARKER"; fi
echo shim >> "$MARKER"
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${rel}" "$@"
else
  exec node  "$basedir/${rel}" "$@"
fi
`
  );
  return dir;
}

// Shadows any real npx on the machine: the wrapper spawns `npx` by name, and
// a real one would reach the registry.
function stubNpx(): string {
  const dir = join(base, 'npx-stub');
  mkdirSync(dir);
  executable(
    join(dir, 'npx'),
    `#!/bin/sh
printf '%s\\n' "$*" > "$MARKER.npx-args"
cat > "$MARKER.stdin"
echo npx >> "$MARKER"
exit 0
`
  );
  return dir;
}

function directoryNamedKmd(): string {
  const dir = join(base, 'dir-kmd');
  mkdirSync(join(dir, 'kmd'), { recursive: true });
  return dir;
}

function nonExecutableKmd(): string {
  const dir = join(base, 'noexec');
  mkdirSync(dir);
  writeFileSync(join(dir, 'kmd'), '#!/bin/sh\necho never\n');
  return dir;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(wrapper: string, dirs: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...HOOK_ARGS], {
      // /bin and /usr/bin supply sh's cat; the stub npx precedes them
      env: { PATH: [npxDir, ...dirs, '/bin', '/usr/bin'].join(':'), MARKER: marker, HOME: base },
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
    child.stdin.end(PAYLOAD);
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
  base = mkdtempSync(join(tmpdir(), 'kmd-resolver-'));
  marker = join(base, 'marker');
  npxDir = stubNpx();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolver floor', () => {
  it('is declared identically in the launcher and the coco resolver', () => {
    expect(COCO_FLOOR_DECL.exec(readFileSync(COCO, 'utf8'))?.slice(1)).toEqual(floor?.slice(1));
  });
});

describe('shared resolver: import, then shim, then npx', () => {
  it('imports a current npm-shaped install in-process', async () => {
    const r = await run(SHARED, [npmInstall('npm', CURRENT)]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['import']);
    expect(r.stdout.trim()).toBe(DENY);
    expect(recorded('.stdin')).toBe(PAYLOAD);
    expect(recorded('.args')).toBe(`${HOOK_ARGS.join(' ')}\n`);
  });

  it('spawns a current shim when nothing is importable, forwarding payload and args', async () => {
    const r = await run(SHARED, [shim('pnpm', CURRENT)]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'shim']);
    expect(r.stdout.trim()).toBe(DENY);
    expect(r.stderr).toBe('');
    expect(recorded('.stdin')).toBe(PAYLOAD);
    expect(recorded('.args')).toBe(`${HOOK_ARGS.join(' ')}\n`);
  });

  it('prefers an importable entry behind a shim and never probes the shim', async () => {
    await run(SHARED, [shim('pnpm', CURRENT), npmInstall('npm', CURRENT)]);
    expect(tiers()).toEqual(['import']);
  });

  it('scans past a stale importable entry to a current shim', async () => {
    await run(SHARED, [npmInstall('old', STALE), shim('pnpm', CURRENT)]);
    expect(tiers()).toEqual(['probe', 'shim']);
  });

  it('scans past an importable entry with no package.json', async () => {
    await run(SHARED, [npmInstall('broken', null), shim('pnpm', CURRENT)]);
    expect(tiers()).toEqual(['probe', 'shim']);
  });

  it('falls back to npx below the floor, with the payload still intact', async () => {
    const r = await run(SHARED, [shim('pnpm', STALE)]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'npx']);
    expect(r.stderr).toContain(`kmd ${STALE}, below ${CURRENT}`);
    expect(recorded('.stdin')).toBe(PAYLOAD);
    expect(recorded('.npx-args')).toBe(`-y @bartolli/kmd@latest ${HOOK_ARGS.join(' ')}\n`);
  });

  it('falls back to npx when the shim cannot answer --version', async () => {
    const r = await run(SHARED, [shim('pnpm', CURRENT, { answersVersion: false })]);
    expect(tiers()).toEqual(['npx']);
    expect(r.stderr).toContain('did not answer --version');
  });

  it('falls back to npx when no kmd is on PATH', async () => {
    const r = await run(SHARED, []);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['npx']);
    expect(r.stderr).toBe('');
  });

  it('treats the shim run as terminal: a crash degrades open without reaching npx', async () => {
    const r = await run(SHARED, [shim('pnpm', CURRENT, { exit: 3 })]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'shim']);
    expect(r.stderr).toContain('exited 3');
  });

  it('skips a directory or a non-executable file named kmd, as the shell does', async () => {
    await run(SHARED, [directoryNamedKmd(), nonExecutableKmd()]);
    expect(tiers()).toEqual(['npx']);
  });

  it("imports a pnpm shim's cmd-shim-target in-process, neither probing nor spawning", async () => {
    npmInstall('linked', CURRENT);
    const r = await run(SHARED, [pnpmShim('pnpm', installedEntry('linked'))]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['import']);
    expect(r.stdout.trim()).toBe(DENY);
    expect(recorded('.stdin')).toBe(PAYLOAD);
  });

  it("imports the target named only in pnpm 10's exec line, neither probing nor spawning", async () => {
    npmInstall('linked', CURRENT);
    const r = await run(SHARED, [pnpm10Shim('pnpm10', installedEntry('linked'))]);
    expect(tiers()).toEqual(['import']);
    expect(r.stdout.trim()).toBe(DENY);
  });

  it('rules a shim out when its target is stale, and keeps scanning', async () => {
    npmInstall('old', STALE);
    await run(SHARED, [pnpmShim('pnpm', installedEntry('old')), shim('opaque', CURRENT)]);
    expect(tiers()).toEqual(['probe', 'shim']);
  });

  it('names the stale target when a shim with a stale target is all there is', async () => {
    npmInstall('old', STALE);
    const r = await run(SHARED, [pnpmShim('pnpm', installedEntry('old'))]);
    expect(tiers()).toEqual(['npx']);
    expect(r.stderr).toContain(`is kmd ${STALE}, below ${CURRENT}`);
    expect(r.stderr).toContain(installedEntry('old'));
  });

  it('trusts the bundle stamp over a newer package.json', async () => {
    const r = await run(SHARED, [npmInstall('skewed', CURRENT, { stamp: STALE })]);
    expect(tiers()).toEqual(['npx']);
    expect(r.stderr).toContain(`is kmd ${STALE}, below ${CURRENT}`);
  });

  it('trusts the bundle stamp over an older package.json', async () => {
    await run(SHARED, [npmInstall('skewed', STALE, { stamp: CURRENT })]);
    expect(tiers()).toEqual(['import']);
  });
});

describe('coco resolver: import, then shim, never npx', () => {
  it('spawns a current shim and delivers the deny', async () => {
    const r = await run(COCO, [shim('pnpm', CURRENT)]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'shim']);
    expect(r.stdout.trim()).toBe(DENY);
    expect(r.stderr).toBe('');
    expect(recorded('.stdin')).toBe(PAYLOAD);
  });

  it('prefers an importable entry behind a shim', async () => {
    const r = await run(COCO, [shim('pnpm', CURRENT), npmInstall('npm', CURRENT)]);
    expect(tiers()).toEqual(['import']);
    expect(r.stdout.trim()).toBe(DENY);
  });

  it('degrades open naming the version when the shim is below the floor', async () => {
    const r = await run(COCO, [shim('pnpm', STALE)]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`kmd ${STALE}, below ${CURRENT}`);
  });

  it('degrades open when no kmd is on PATH', async () => {
    const r = await run(COCO, []);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual([]);
    expect(r.stderr).toContain('no kmd on PATH');
  });

  it('degrades open when the shim crashes', async () => {
    const r = await run(COCO, [shim('pnpm', CURRENT, { exit: 3 })]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual(['probe', 'shim']);
    expect(r.stderr).toContain('exited 3');
  });

  it("imports a pnpm shim's cmd-shim-target in-process", async () => {
    npmInstall('linked', CURRENT);
    const r = await run(COCO, [pnpmShim('pnpm', installedEntry('linked'))]);
    expect(tiers()).toEqual(['import']);
    expect(r.stdout.trim()).toBe(DENY);
    expect(r.stderr).toBe('');
  });

  it("imports the target named only in pnpm 10's exec line", async () => {
    npmInstall('linked', CURRENT);
    const r = await run(COCO, [pnpm10Shim('pnpm10', installedEntry('linked'))]);
    expect(tiers()).toEqual(['import']);
    expect(r.stdout.trim()).toBe(DENY);
  });

  it('degrades open naming a stale shim target, never spawning it', async () => {
    npmInstall('old', STALE);
    const r = await run(COCO, [pnpmShim('pnpm', installedEntry('old'))]);
    expect(r.code).toBe(0);
    expect(tiers()).toEqual([]);
    expect(r.stderr).toContain(`is kmd ${STALE}, below ${CURRENT}`);
    expect(r.stderr).toContain('rebuild');
  });

  it('degrades open naming a stale npm-shaped install', async () => {
    const r = await run(COCO, [npmInstall('old', STALE)]);
    expect(tiers()).toEqual([]);
    expect(r.stderr).toContain(`is kmd ${STALE}, below ${CURRENT}`);
  });

  it('trusts the bundle stamp over a newer package.json', async () => {
    const r = await run(COCO, [npmInstall('skewed', CURRENT, { stamp: STALE })]);
    expect(tiers()).toEqual([]);
    expect(r.stderr).toContain(`is kmd ${STALE}, below ${CURRENT}`);
  });
});
