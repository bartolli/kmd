import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  canonicalVaultRoot,
  getMeta,
  indexRootDir,
  openDatabase,
  resolveIndexPath
} from '@llm-wiki/db/database';
import {
  loadGlobalConfig,
  resolveVaultRoot,
  setGlobalConfigValue,
  unsetGlobalConfigValue,
  type VaultRootResolution
} from '@llm-wiki/db/kmd-config';
import { loadVaultConfig } from '@llm-wiki/db/vault-config';
import { runSync } from './sync.js';
import { upgradeVault } from './upgrade.js';
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

/** The one chain, from the CLI's inputs; project signal = KMD_PROJECT_DIR ?? cwd. */
export function resolveCliVault(positional?: string, defaultRoot?: string): VaultRootResolution {
  return resolveVaultRoot({
    positional,
    defaultRoot,
    projectDir: process.env.KMD_PROJECT_DIR ?? process.cwd(),
    envVault: process.env.WIKI_VAULT,
    globalDefault: loadGlobalConfig().default_vault,
    onSkip: (candidate) =>
      console.error(
        `kmd: ignoring ${candidate} — no .kmd marker beside it; mkdir ${dirname(candidate)}/.kmd to bind it as the project vault`
      )
  });
}

const SOURCE_LABELS: Record<VaultRootResolution['source'], string> = {
  positional: 'positional',
  'project-local-config': 'project tier (local config)',
  'project-config': 'project tier (config)',
  'project-convention': 'project tier (convention)',
  'default-root': '--default-root',
  env: '$WIKI_VAULT',
  'global-config': 'global config (default_vault)',
  none: 'none'
};

const NO_VAULT_HINT =
  'no vault resolvable — pass a vault root, run inside a project vault, set WIKI_VAULT, or `kmd config set default_vault <path>`';

/** Resolve or die loud; on success, pin WIKI_VAULT so downstream code agrees. */
function requireCliVault(positional?: string): { root: string; resolution: VaultRootResolution } {
  const resolution = resolveCliVault(positional);
  if (resolution.root === null) {
    console.error(NO_VAULT_HINT);
    process.exit(1);
  }
  process.env.WIKI_VAULT = resolution.root;
  return { root: resolution.root, resolution };
}

function reportFindings(findings: Finding[]): void {
  for (const f of findings) {
    console.error(`${f.severity}: ${f.path} [${f.rule}] ${f.message}`);
  }
}

export { runInit } from './init.js';

export async function runValidate(positional?: string): Promise<void> {
  const { root } = requireCliVault(positional);
  const findings = await validateVault(root);
  reportFindings(findings);
  console.log(`validate: ${findings.length} finding(s)`);
  process.exit(hasErrors(findings) ? 1 : 0);
}

export async function runSyncCommand(positional?: string): Promise<void> {
  const { root } = requireCliVault(positional);
  const findings = await validateVault(root);
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

export async function runConfig(positional?: string): Promise<void> {
  const resolution = resolveCliVault(positional);
  if (resolution.root !== null) {
    printVault(describeVault(resolution.root));
    console.log(`source: ${SOURCE_LABELS[resolution.source]}`);
    return;
  }
  const known = knownVaults();
  if (known.length === 0) {
    console.error(NO_VAULT_HINT);
    process.exit(1);
  }
  known.forEach((d, i) => {
    if (i > 0) console.log('');
    printVault(d);
  });
}

export async function runConfigSet(key?: string, value?: string): Promise<void> {
  if (key !== 'default_vault' || !value) {
    console.error('usage: kmd config set default_vault <path>');
    process.exit(2);
  }
  const vault = resolve(value);
  // fail loud before recording: the default must point at a loadable vault
  await loadVaultConfig(vault);
  setGlobalConfigValue('default_vault', vault);
  console.log(`default_vault: ${vault}`);
}

export async function runConfigGet(key?: string): Promise<void> {
  if (key !== 'default_vault') {
    console.error('usage: kmd config get default_vault');
    process.exit(2);
  }
  const value = loadGlobalConfig().default_vault;
  if (value === undefined) process.exit(1);
  console.log(value);
}

export async function runConfigUnset(key?: string): Promise<void> {
  if (key !== 'default_vault') {
    console.error('usage: kmd config unset default_vault');
    process.exit(2);
  }
  if (!unsetGlobalConfigValue('default_vault')) {
    console.error('default_vault is not set');
    process.exit(1);
  }
  console.log('default_vault unset');
}

export async function runDbReset(positional?: string): Promise<void> {
  const resolution = resolveCliVault(positional);
  if (resolution.root === null) {
    console.error('usage: kmd db reset [<vault-root>] (or set WIKI_VAULT)');
    process.exit(2);
  }
  const dir = dirname(resolveIndexPath(resolution.root));
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

export async function runInitUpgrade(
  positional: string | undefined,
  apply: boolean
): Promise<void> {
  const { root } = requireCliVault(positional);
  const result = await upgradeVault(root, { apply });
  for (const line of result.lines) console.log(line);
  process.exit(result.code);
}
