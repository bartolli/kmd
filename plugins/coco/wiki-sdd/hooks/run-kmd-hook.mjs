#!/usr/bin/env node
// Resolver for kmd gate hooks, CoCo flavor. Unlike the claude/codex wrapper
// there is no npx fallback: CoCo deployments are typically managed
// environments where `npx` is blocked or offline, and a fallback that cannot
// run is worse than none — it turns a missing prerequisite into a silent
// no-op. A globally installed kmd at MIN_HOOK_VERSION or newer is imported
// in-process (one node startup); anything else exits 0 with one stderr line
// naming the fix. Exiting 0 is the contract: exit 2 on UserPromptSubmit
// blocks the user's prompt, so gates fail open, loudly.
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_HOOK_VERSION = [0, 12, 0];
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`kmd hook wrapper: ${message}\n`);
  process.exit(0);
}

function hookCapableEntry() {
  if (process.platform === 'win32') return { entry: null, reason: 'unsupported platform' };
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    let entry;
    try {
      entry = realpathSync(join(dir, 'kmd'));
    } catch {
      continue;
    }
    if (!/\.(mjs|cjs|js)$/.test(entry)) {
      return { entry: null, reason: `kmd on PATH is not a node entry (${entry})` };
    }
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
      const raw = String(pkg.version ?? '0.0.0');
      const version = raw.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if ((version[i] ?? 0) > MIN_HOOK_VERSION[i]) return { entry, reason: null };
        if ((version[i] ?? 0) < MIN_HOOK_VERSION[i]) {
          return { entry: null, reason: `kmd ${raw} predates ${MIN_HOOK_VERSION.join('.')}` };
        }
      }
      return { entry, reason: null };
    } catch {
      return { entry: null, reason: 'kmd on PATH has no readable package.json' };
    }
  }
  return { entry: null, reason: 'no kmd on PATH' };
}

const { entry, reason } = hookCapableEntry();
if (entry === null) {
  fail(`${reason} — gates are off. Install with \`npm i -g @bartolli/kmd\``);
}

process.argv = [process.argv[0], entry, ...args];
try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  fail(`import failed (${error instanceof Error ? error.message : String(error)})`);
}
