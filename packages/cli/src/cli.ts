import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  canonicalVaultRoot,
  getMeta,
  indexRootDir,
  openDatabase,
  resolveIndexPath
} from '@llm-wiki/db/database';
import { runSync } from './sync.js';
import { type Finding, hasErrors, validateVault } from './validate.js';

export type Command = 'sync' | 'validate';

export type CliResolution = { kind: 'run'; command: Command } | { kind: 'error'; message: string };

/**
 * Resolve a `wiki <command>` invocation to the command to run, or a usage
 * error. Pure — no side effects — so the routing is testable without executing
 * the (index-touching) command. `argv` is `process.argv.slice(2)`.
 */
export function resolveCli(argv: string[]): CliResolution {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false });
  const command = positionals[0];
  if (command === 'sync') {
    return { kind: 'run', command: 'sync' };
  }
  if (command === 'validate') {
    return { kind: 'run', command: 'validate' };
  }
  if (command === undefined) {
    return { kind: 'error', message: 'usage: wiki <sync|validate>' };
  }
  return { kind: 'error', message: `unknown command: ${command}` };
}

export function vaultRoot(): string {
  const root = process.env.WIKI_VAULT;
  if (!root) {
    console.error('WIKI_VAULT is not set');
    process.exit(1);
  }
  return root;
}

function reportFindings(findings: Finding[]): void {
  for (const f of findings) {
    console.error(`${f.severity}: ${f.path} [${f.rule}] ${f.message}`);
  }
}

export { runInit } from './init.js';

export async function runValidate(): Promise<void> {
  const findings = await validateVault(vaultRoot());
  reportFindings(findings);
  console.log(`validate: ${findings.length} finding(s)`);
  process.exit(hasErrors(findings) ? 1 : 0);
}

export async function runSyncCommand(): Promise<void> {
  const findings = await validateVault(vaultRoot());
  reportFindings(findings);
  if (hasErrors(findings)) {
    const errors = findings.filter((f) => f.severity === 'error').length;
    console.error(`sync aborted: ${errors} validation error(s); no database writes`);
    process.exit(1);
  }
  await runSync();
}

interface VaultDescription {
  vault: string;
  index: string;
  synced: string;
}

// Read-only: never creates the index file or its directory — `config` must
// not leave state behind for vaults that were merely asked about.
function describeVault(root: string): VaultDescription {
  const vault = canonicalVaultRoot(root);
  const index = resolveIndexPath(vault);
  let synced = 'never';
  if (existsSync(index)) {
    const db = openDatabase(index);
    try {
      synced = getMeta(db, 'last_synced') ?? 'never';
    } finally {
      db.close();
    }
  }
  return { vault, index, synced };
}

function printVault(d: VaultDescription): void {
  console.log(`vault: ${d.vault}`);
  console.log(`index: ${d.index}`);
  console.log(`synced: ${d.synced}`);
}

/** Every per-vault index under `~/.kmd/db/` that records its vault root. */
function knownVaults(): VaultDescription[] {
  const root = indexRootDir();
  if (!existsSync(root)) return [];
  const known: VaultDescription[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = join(root, entry.name, 'index.db');
    if (!existsSync(index)) continue;
    const db = openDatabase(index);
    try {
      const vault = getMeta(db, 'vault_root');
      if (vault === null) continue;
      known.push({ vault, index, synced: getMeta(db, 'last_synced') ?? 'never' });
    } finally {
      db.close();
    }
  }
  return known;
}

export async function runConfig(): Promise<void> {
  const root = process.env.WIKI_VAULT;
  if (root) {
    printVault(describeVault(root));
    return;
  }
  const known = knownVaults();
  if (known.length === 0) {
    console.error(
      'no vault specified and none known — pass a vault root, set WIKI_VAULT, or run `kmd sync <vault-root>` once'
    );
    process.exit(1);
  }
  known.forEach((d, i) => {
    if (i > 0) console.log('');
    printVault(d);
  });
}

export async function runDbReset(): Promise<void> {
  const root = process.env.WIKI_VAULT;
  if (!root) {
    console.error('usage: kmd db reset [<vault-root>] (or set WIKI_VAULT)');
    process.exit(2);
  }
  const dir = dirname(resolveIndexPath(root));
  if (!existsSync(dir)) {
    console.log(`${dir} does not exist — nothing to reset`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`deleted ${dir}`);
}

export async function main(): Promise<void> {
  const resolution = resolveCli(process.argv.slice(2));
  if (resolution.kind === 'error') {
    console.error(resolution.message);
    process.exit(1);
  }
  if (resolution.command === 'sync') {
    await runSyncCommand();
  } else {
    await runValidate();
  }
}
