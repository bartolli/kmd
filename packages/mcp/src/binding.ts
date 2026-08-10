import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  findProjectTier,
  resolveVaultRoot,
  type SkipListener,
  type VaultRootResolution
} from '@llm-wiki/db/kmd-config';
import type { VaultConfig } from '@llm-wiki/db/vault-config';

export interface VaultBinding {
  readonly vaultRoot: string;
  readonly db: DatabaseSync;
  readonly vaultConfig: VaultConfig;
}

/**
 * A resolved binding serves immediately (today's startup contract); a promise
 * defers the vault to bind time — handlers await it, and any call that races
 * the bind parks until it lands (or dies with the process if the bind fails
 * loud).
 */
export type Binding = VaultBinding | Promise<VaultBinding>;

/** Client roots as local directories: `file://` URIs only, malformed skipped. */
export function projectDirsFromRoots(roots: ReadonlyArray<{ uri: string }>): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    if (!root.uri.startsWith('file://')) continue;
    try {
      dirs.push(fileURLToPath(root.uri));
    } catch {
      // malformed URI — not a usable project signal
    }
  }
  return dirs;
}

export interface DeferredResolveInput {
  /**
   * Ordered client roots as local dirs; `null` means the client declared no
   * `roots` capability (distinct from an empty roots list).
   */
  readonly rootDirs: ReadonlyArray<string> | null;
  /** Server process cwd — the legacy project signal for roots-less clients. */
  readonly cwd: string;
  readonly defaultRoot?: string | undefined;
  readonly envVault?: string | undefined;
  readonly globalDefault?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly onSkip?: SkipListener | undefined;
}

/**
 * Bind-time resolution for roots-sourced project-aware mode. `roots/list` is a
 * project-signal source feeding the same tier walk `KMD_PROJECT_DIR` would —
 * not a new chain rank. One signal per entry point: when the client declares
 * roots they replace the cwd signal entirely (first mapping root binds; a miss
 * falls through to --default-root > $WIKI_VAULT > global default_vault); a
 * client without the capability keeps the cwd-fed chain unchanged.
 */
export function resolveDeferredVault(input: DeferredResolveInput): VaultRootResolution {
  const env = input.env ?? process.env;
  if (input.rootDirs === null) {
    return resolveVaultRoot({
      projectDir: input.cwd,
      defaultRoot: input.defaultRoot,
      envVault: input.envVault,
      globalDefault: input.globalDefault,
      env,
      onSkip: input.onSkip
    });
  }
  for (const dir of input.rootDirs) {
    const tier = findProjectTier(dir, env, input.onSkip);
    if (tier !== null) {
      return { root: tier.vaultRoot, source: `project-${tier.via}`, tierRoot: tier.tierRoot };
    }
  }
  return resolveVaultRoot({
    defaultRoot: input.defaultRoot,
    envVault: input.envVault,
    globalDefault: input.globalDefault,
    env
  });
}
