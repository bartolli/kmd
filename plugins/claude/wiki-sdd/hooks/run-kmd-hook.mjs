#!/usr/bin/env node
// Resolver for kmd gate hooks. Fast path: an installed kmd whose version is
// >= MIN_HOOK_VERSION is imported in-process — one node startup, no npx
// registry resolution (~0.15s vs ~0.65s warm). Fallback: npx @latest. The
// version gate keeps a stale global (no `hook` command, exits 2 = prompt
// block on UserPromptSubmit) off the fast path. A wrapper failure must never
// block the harness event — degrade open.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_HOOK_VERSION = [0, 10, 0];
const args = process.argv.slice(2);

function hookCapableEntry() {
  if (process.platform === 'win32') return null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    let entry;
    try {
      entry = realpathSync(join(dir, 'kmd'));
    } catch {
      continue;
    }
    if (!/\.(mjs|cjs|js)$/.test(entry)) return null;
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
      const version = String(pkg.version ?? '0.0.0').split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if ((version[i] ?? 0) > MIN_HOOK_VERSION[i]) return entry;
        if ((version[i] ?? 0) < MIN_HOOK_VERSION[i]) return null;
      }
      return entry;
    } catch {
      return null;
    }
  }
  return null;
}

function runNpx() {
  const child = spawn('npx', ['-y', '@bartolli/kmd@latest', ...args], { stdio: 'inherit' });
  child.on('error', (error) => {
    process.stderr.write(`kmd hook wrapper: ${error.message}\n`);
    process.exit(0);
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

const entry = hookCapableEntry();
if (entry === null) {
  runNpx();
} else {
  process.argv = [process.argv[0], entry, ...args];
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kmd hook wrapper: import failed (${message}) — falling back to npx\n`);
    runNpx();
  }
}
