import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Document, parse, parseDocument } from 'yaml';
import { z } from 'zod';
import { canonicalVaultRoot, kmdHome } from './database.js';

// Two config tiers, no central registry: global ~/.kmd/config.yaml (personal,
// absolutes fine) and project <repo>/.kmd/ (committed config.yaml carries only
// repo-relative paths or ${VAR} expansions; gitignored config.local.yaml
// carries personal absolutes). Inputs are kmd-owned only — harness tokens map
// into KMD_PROJECT_DIR in adapter chrome, never read here by name.

const GlobalConfigSchema = z.strictObject({
  default_vault: z.string().min(1).optional()
});

const ProjectConfigSchema = z.strictObject({
  vault: z.string().min(1).optional()
});

/** `${VAR}` / `${VAR:-default}`; an unset variable with no default throws. */
export function expandVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== '') return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(`unresolved \${${name}} (variable unset, no :-default)`);
    }
  );
}

function expandHome(value: string): string {
  if (value === '~' || value.startsWith('~/')) return join(homedir(), value.slice(1));
  return value;
}

function loadYamlFile<T>(path: string, schema: z.ZodType<T>): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const parsed = schema.safeParse(parse(raw) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid config: ${path}\n${issues}`);
  }
  return parsed.data;
}

export function globalConfigPath(): string {
  return join(kmdHome(), 'config.yaml');
}

export interface GlobalConfig {
  readonly default_vault?: string | undefined;
}

/** Absent file is an empty config; a malformed one throws (intentional state fails loud). */
export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  const config = loadYamlFile(globalConfigPath(), GlobalConfigSchema);
  if (config === null || config.default_vault === undefined) return {};
  const expanded = expandHome(expandVars(config.default_vault, env));
  if (!isAbsolute(expanded)) {
    throw new Error(
      `invalid config: ${globalConfigPath()}\n  - default_vault: must be absolute or ~/ (got "${config.default_vault}")`
    );
  }
  return { default_vault: expanded };
}

// Comment-preserving writes: parse to a Document, mutate, serialize — a hand
// commented config survives `kmd config set`.
function loadGlobalDocument(): Document {
  try {
    return parseDocument(readFileSync(globalConfigPath(), 'utf8'));
  } catch {
    return new Document({});
  }
}

function flushGlobalDocument(doc: Document): void {
  mkdirSync(kmdHome(), { recursive: true });
  writeFileSync(globalConfigPath(), doc.toString());
}

export function setGlobalConfigValue(key: 'default_vault', value: string): void {
  const doc = loadGlobalDocument();
  doc.set(key, value);
  flushGlobalDocument(doc);
}

export function unsetGlobalConfigValue(key: 'default_vault'): boolean {
  const doc = loadGlobalDocument();
  if (!doc.has(key)) return false;
  doc.delete(key);
  flushGlobalDocument(doc);
  return true;
}

export interface ProjectTier {
  readonly tierRoot: string;
  readonly vaultRoot: string;
  readonly via: 'local-config' | 'config' | 'convention';
}

const TIER_CONFIG_FILES = [
  ['config.local.yaml', 'local-config'],
  ['config.yaml', 'config']
] as const;

function projectVaultAt(level: string, env: NodeJS.ProcessEnv): ProjectTier | null {
  for (const [file, via] of TIER_CONFIG_FILES) {
    const path = join(level, '.kmd', file);
    const config = loadYamlFile(path, ProjectConfigSchema);
    if (config === null || config.vault === undefined) continue;
    const expanded = expandHome(expandVars(config.vault, env));
    return {
      tierRoot: level,
      vaultRoot: isAbsolute(expanded) ? expanded : resolve(level, expanded),
      via
    };
  }
  if (existsSync(join(level, 'vault', 'vault.yaml'))) {
    return { tierRoot: level, vaultRoot: join(level, 'vault'), via: 'convention' };
  }
  if (existsSync(join(level, 'vault.yaml'))) {
    return { tierRoot: level, vaultRoot: level, via: 'convention' };
  }
  return null;
}

/**
 * Nearest-ancestor project tier from `fromDir`: at each level,
 * `.kmd/config.local.yaml` > `.kmd/config.yaml` > `vault/vault.yaml` >
 * `vault.yaml`. Relative config paths resolve against the tier root.
 */
export function findProjectTier(
  fromDir: string,
  env: NodeJS.ProcessEnv = process.env
): ProjectTier | null {
  let level = canonicalVaultRoot(fromDir);
  for (;;) {
    const hit = projectVaultAt(level, env);
    if (hit !== null) return hit;
    const parent = dirname(level);
    if (parent === level) return null;
    level = parent;
  }
}

export type VaultRootSource =
  | 'positional'
  | 'project-local-config'
  | 'project-config'
  | 'project-convention'
  | 'default-root'
  | 'env'
  | 'global-config'
  | 'none';

export interface VaultRootResolution {
  readonly root: string | null;
  readonly source: VaultRootSource;
  readonly tierRoot?: string | undefined;
}

/**
 * The one chain, every entry point: positional (explicit, authoritative) >
 * project tier > --default-root > $WIKI_VAULT > global default_vault > none.
 * Arguments are explicit; ambient sources resolve most-specific-first.
 * Callers enforce positional/--default-root mutual exclusion.
 */
export function resolveVaultRoot(input: {
  positional?: string | undefined;
  defaultRoot?: string | undefined;
  projectDir?: string | undefined;
  envVault?: string | undefined;
  globalDefault?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): VaultRootResolution {
  if (input.positional) return { root: input.positional, source: 'positional' };
  if (input.projectDir) {
    const tier = findProjectTier(input.projectDir, input.env ?? process.env);
    if (tier !== null) {
      return { root: tier.vaultRoot, source: `project-${tier.via}`, tierRoot: tier.tierRoot };
    }
  }
  if (input.defaultRoot) return { root: input.defaultRoot, source: 'default-root' };
  if (input.envVault) return { root: input.envVault, source: 'env' };
  if (input.globalDefault) return { root: input.globalDefault, source: 'global-config' };
  return { root: null, source: 'none' };
}
