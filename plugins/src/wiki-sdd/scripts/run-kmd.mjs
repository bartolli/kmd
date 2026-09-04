#!/usr/bin/env node
// Launcher for the Package. A conformant client runs it from mcp.json as
// `node ${PLUGIN_ROOT}/scripts/run-kmd.mjs mcp`; a harness's hook wiring runs
// it with `hook <event> …`. Three tiers, cheapest first.
//   import — a PATH `kmd` that resolves to a node entry (npm's bin is a symlink
//            at kmd.mjs; pnpm's shim names its target in a cmd-shim trailer)
//            whose version clears MIN_KMD_VERSION is imported in-process: one
//            node startup (~0.15s vs ~0.65s warm npx).
//   spawn  — an executable shim with no readable target (Volta's binary) still
//            runs locally, so it is asked its version (one extra startup, this
//            tier only) and spawned when it clears the floor.
//   npx    — `npx -y @bartolli/kmd@latest`, registry resolution; where npx is
//            absent, one stderr line.
// The floor keeps a stale global off both local tiers: a `hook`-unaware kmd
// exits non-zero (a prompt block on UserPromptSubmit), and a hook-capable but
// older engine silently runs behavior this wiring no longer expects. Falling
// back is only possible before the payload on stdin is consumed, so the spawn
// is terminal. A hook run exits 0 on every path but one — a launcher failure
// must never block a harness event — and the one is the engine's exit 2, the
// deny the kiro codec renders, which passes through untouched. Any other
// subcommand propagates the exit, so a client sees a server that failed to
// start.
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_KMD_VERSION = [0, 16, 0];
const FLOOR = MIN_KMD_VERSION.join('.');
const IMPORTABLE = /\.(mjs|cjs|js)$/;
const args = process.argv.slice(2);
const degradeOpen = args[0] === 'hook';

function diagnose(message) {
  process.stderr.write(`kmd launcher: ${message}\n`);
}

function finish(code) {
  if (!degradeOpen) return process.exit(code);
  process.exit(code === 2 ? 2 : 0);
}

function meetsFloor(raw) {
  const version = String(raw).trim().split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((version[i] ?? 0) > MIN_KMD_VERSION[i]) return true;
    if ((version[i] ?? 0) < MIN_KMD_VERSION[i]) return false;
  }
  return true;
}

function runnable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The version of the code that runs: the build stamp in the bundle head.
// package.json beside the bundle serves bundles built before the stamp; on a
// source-linked install it can be newer than the bundle, which is why the
// stamp is read first.
function entryVersion(entry) {
  try {
    const fd = openSync(entry, 'r');
    try {
      const head = Buffer.alloc(256);
      const n = readSync(fd, head, 0, head.length, 0);
      const stamp = /kmd-version=(\d+\.\d+\.\d+)/.exec(head.toString('utf8', 0, n));
      if (stamp !== null) return stamp[1];
    } finally {
      closeSync(fd);
    }
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return null;
  }
}

// pnpm's shim names the importable file it would exec: pnpm 11's cmd-shim in
// a `# cmd-shim-target=<path>` trailer, pnpm 10's only in the exec line,
// relative to the shim's own directory. The size cap keeps a binary shim
// unread; anything unparsed stays opaque and takes the probe.
function shimTarget(shim) {
  try {
    if (statSync(shim).size > 16_384) return null;
    const text = readFileSync(shim, 'utf8');
    const named =
      /^# cmd-shim-target=(.+)$/m.exec(text)?.[1] ??
      /^\s*exec (?:"\$basedir\/node"|node)\s+"\$basedir\/([^"]+)"/m.exec(text)?.[1];
    if (named === undefined) return null;
    const target = realpathSync(resolve(dirname(shim), named.trim()));
    return IMPORTABLE.test(target) ? target : null;
  } catch {
    return null;
  }
}

// The scan never stops early: a shim or a stale package earlier on PATH must
// not hide an importable, current one behind it. The first runnable opaque
// shim is the spawn candidate — the shell's own pick when nothing is
// importable — and the first below-floor entry is kept for the diagnostic.
function resolveLocal() {
  if (process.platform === 'win32') return { entry: null, shim: null, stale: null };
  let shim = null;
  let stale = null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    let candidate;
    try {
      candidate = realpathSync(join(dir, 'kmd'));
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    if (!IMPORTABLE.test(candidate)) {
      if (!runnable(candidate)) continue;
      const target = shimTarget(candidate);
      if (target === null) {
        if (shim === null) shim = candidate;
        continue;
      }
      candidate = target;
    }
    const version = entryVersion(candidate);
    if (version === null) continue;
    if (meetsFloor(version)) return { entry: candidate, shim, stale };
    if (stale === null) stale = { path: candidate, version };
  }
  return { entry: null, shim, stale };
}

// The shim's version is unreadable from disk, so it is asked. stdin stays
// untouched: the probe must leave the payload for whichever tier runs.
function shimVersion(shim) {
  const probe = spawnSync(shim, ['--version'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 10_000
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  return /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0] ?? null;
}

function attach(child, name, onStartError) {
  child.on('error', onStartError);
  child.on('close', (code, signal) => {
    if (signal !== null) {
      diagnose(`${name} ended by ${signal}`);
      return finish(1);
    }
    if (degradeOpen && code === 2) return finish(2);
    if (code !== 0) diagnose(`${name} exited ${code}${degradeOpen ? ' — degrading open' : ''}`);
    finish(code);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

function runNpx() {
  const child = spawn('npx', ['-y', '@bartolli/kmd@latest', ...args], { stdio: 'inherit' });
  attach(child, 'npx', (error) => {
    diagnose(`no kmd at or above ${FLOOR} on PATH, and npx failed to start (${error.message})`);
    finish(1);
  });
}

function runShim(shim) {
  const child = spawn(shim, args, { stdio: 'inherit' });
  attach(child, shim, (error) => {
    // never started, payload intact — the registry tier can still run
    diagnose(`${shim} failed to start (${error.message}) — falling back to npx`);
    runNpx();
  });
}

function runLocalOrNpx(shim, stale) {
  if (shim === null) {
    if (stale !== null) {
      diagnose(`${stale.path} is kmd ${stale.version}, below ${FLOOR} — falling back to npx`);
    }
    return runNpx();
  }
  const version = shimVersion(shim);
  if (version === null) {
    diagnose(`${shim} did not answer --version — falling back to npx`);
    return runNpx();
  }
  if (!meetsFloor(version)) {
    diagnose(`${shim} is kmd ${version}, below ${FLOOR} — falling back to npx`);
    return runNpx();
  }
  runShim(shim);
}

const { entry, shim, stale } = resolveLocal();
if (entry === null) {
  runLocalOrNpx(shim, stale);
} else {
  process.argv = [process.argv[0], entry, ...args];
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnose(`import failed (${message}) — falling back`);
    runLocalOrNpx(shim, stale);
  }
}
