#!/usr/bin/env node
// Resolver for kmd gate hooks, CoCo flavor. Two local tiers and no npx: CoCo
// deployments are typically managed environments where `npx` is blocked or
// offline, and a fallback that cannot run is worse than none — it turns a
// missing prerequisite into a silent no-op. A PATH `kmd` that resolves to a
// node entry (npm's symlink, or the target named in pnpm's cmd-shim trailer)
// whose version clears MIN_HOOK_VERSION is imported in-process; an executable
// shim with no readable target (Volta's binary) is asked its version and
// spawned when it clears the floor; anything else exits 0 with one stderr
// line naming the cause. Exiting 0 is the contract: exit 2 on
// UserPromptSubmit blocks the user's prompt, so gates fail open, loudly.
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

const MIN_HOOK_VERSION = [0, 12, 1];
const FLOOR = MIN_HOOK_VERSION.join('.');
const IMPORTABLE = /\.(mjs|cjs|js)$/;
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`kmd hook wrapper: ${message}\n`);
  process.exit(0);
}

function meetsFloor(raw) {
  const version = String(raw).trim().split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((version[i] ?? 0) > MIN_HOOK_VERSION[i]) return true;
    if ((version[i] ?? 0) < MIN_HOOK_VERSION[i]) return false;
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
// untouched: the probe must leave the payload for the spawn.
function shimVersion(shim) {
  const probe = spawnSync(shim, ['--version'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 10_000
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  return /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0] ?? null;
}

function runShim(shim) {
  const child = spawn(shim, args, { stdio: 'inherit' });
  child.on('error', (error) => fail(`${shim} failed to start (${error.message}) — gates are off`));
  child.on('close', (code) => {
    // terminal: the payload is consumed, and kmd hook exits 0 by contract
    if (code !== 0 && code !== null) fail(`${shim} exited ${code} — gates are off`);
    process.exit(0);
  });
}

function runLocal(shim, stale) {
  if (shim === null) {
    if (stale !== null) {
      fail(`${stale.path} is kmd ${stale.version}, below ${FLOOR} — gates are off. Upgrade or rebuild the global kmd`);
    }
    fail(`no kmd on PATH — gates are off. Install kmd ${FLOOR} or newer globally`);
  }
  const version = shimVersion(shim);
  if (version === null) fail(`${shim} did not answer --version — gates are off`);
  if (!meetsFloor(version)) {
    fail(`${shim} is kmd ${version}, below ${FLOOR} — gates are off. Upgrade or rebuild the global kmd`);
  }
  runShim(shim);
}

if (process.platform === 'win32') fail('unsupported platform — gates are off');

const { entry, shim, stale } = resolveLocal();
if (entry === null) {
  runLocal(shim, stale);
} else {
  process.argv = [process.argv[0], entry, ...args];
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kmd hook wrapper: import failed (${message}) — falling back\n`);
    runLocal(shim, stale);
  }
}
