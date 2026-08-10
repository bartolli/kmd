#!/usr/bin/env node
// Claude chrome: applies the per-project vault override, then delegates to
// the byte-shared resolver wrapper beside it. The claude-only property is
// structural — only this adapter's hooks.json registers this entry, so no
// other harness runs it regardless of env. Misses stay silent: the override
// file is absent in most projects and this fires on every harness event.
// A chrome failure must never block the event — degrade open, exit 0.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

applyProjectVaultOverride();

function applyProjectVaultOverride() {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    if (!projectDir) return;
    // argv contract: [node, this-script, 'hook', <event>, <vault-root>, ...flags]
    if (process.argv[2] !== 'hook') return;
    const root = process.argv[4];
    if (typeof root !== 'string' || root === '' || root.startsWith('-')) return;
    const raw = readFileSync(join(projectDir, '.claude', 'wiki-sdd.local.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (frontmatter === null) return;
    const line = /^vault_path:[ \t]*("?)(.+?)\1[ \t]*$/m.exec(frontmatter[1]);
    if (line === null) return;
    let vaultPath = line[2].trim();
    if (vaultPath === '~' || vaultPath.startsWith('~/')) {
      vaultPath = join(homedir(), vaultPath.slice(1));
    }
    // README contract: absolute or ~/ paths only — a relative or quoted-junk
    // value falls back to the configured vault rather than resolving off cwd.
    if (isAbsolute(vaultPath)) process.argv[4] = vaultPath;
  } catch {
    // unreadable or malformed override — keep the configured vault root
  }
}

try {
  await import('./run-kmd-hook.mjs');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wiki-sdd claude hook chrome: delegation failed (${message})\n`);
  process.exit(0);
}
