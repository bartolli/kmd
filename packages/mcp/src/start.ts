import { loadVaultConfig } from '@llm-wiki/db/vault-config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { projectDirsFromRoots, resolveDeferredVault, type VaultBinding } from './binding.js';
import { loadConfig, loadServerEnv } from './config.js';
import { createDatabase } from './db.js';
import { diag } from './lib/diag.js';
import { createLogger, type Logger } from './lib/logger.js';
import { buildServer } from './server.js';

function installShutdown(
  mcp: { close(): Promise<void> },
  logger: Logger,
  getDb: () => { close(): void } | null
): void {
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    diag('shutting down', { signal });
    try {
      await mcp.close();
      getDb()?.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.once('SIGINT', (s) => void shutdown(s));
  process.once('SIGTERM', (s) => void shutdown(s));
}

/**
 * Roots-sourced project-aware mode: no positional, no KMD_PROJECT_DIR. The
 * vault binds after initialization from the client's roots (or the fallback
 * chain); until then the caller's resolution inputs ride here.
 */
export interface DeferredStartInput {
  readonly cwd: string;
  readonly defaultRoot?: string | undefined;
  readonly envVault?: string | undefined;
  readonly globalDefault?: string | undefined;
}

export async function startMcpServer(deferred?: DeferredStartInput): Promise<void> {
  diag('main entered');
  if (deferred) return startDeferred(deferred);

  const config = loadConfig();
  diag('config loaded', { vault: config.wikiVault, level: config.logLevel });

  const vaultConfig = await loadVaultConfig(config.wikiVault);
  diag('vault config loaded', {
    scopes: Object.keys(vaultConfig.scopes).length,
    kinds: vaultConfig.kinds.length,
    statuses: vaultConfig.statuses.length
  });

  const logger = createLogger(config.logLevel, config.serverName);
  logger.info(
    { vault: config.wikiVault, serverName: config.serverName, serverVersion: config.serverVersion },
    'starting wiki-mcp on stdio'
  );

  const db = createDatabase(config.wikiVault);
  diag('database opened');

  const mcp = buildServer({
    name: config.serverName,
    version: config.serverVersion,
    logger,
    binding: { vaultRoot: config.wikiVault, db, vaultConfig }
  });
  diag('server built');

  installShutdown(mcp, logger, () => db);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('wiki-mcp ready');
  diag('ready and connected to transport');
}

async function startDeferred(input: DeferredStartInput): Promise<void> {
  const env = loadServerEnv();
  diag('config loaded, vault binding deferred', { level: env.logLevel, cwd: input.cwd });

  const logger = createLogger(env.logLevel, env.serverName);
  logger.info(
    { serverName: env.serverName, serverVersion: env.serverVersion },
    'starting wiki-mcp on stdio; vault binding deferred to after initialization'
  );

  let resolveBinding!: (bound: VaultBinding) => void;
  const binding = new Promise<VaultBinding>((resolve) => {
    resolveBinding = resolve;
  });

  const mcp = buildServer({
    name: env.serverName,
    version: env.serverVersion,
    logger,
    binding
  });
  diag('server built (deferred binding)');

  let bound: VaultBinding | null = null;

  const bind = async (): Promise<void> => {
    let rootDirs: string[] | null = null;
    if (mcp.server.getClientCapabilities()?.roots) {
      const { roots } = await mcp.server.listRoots();
      rootDirs = projectDirsFromRoots(roots);
      diag('client roots received', { uris: roots.map((r) => r.uri), dirs: rootDirs });
    } else {
      diag('client declares no roots capability; falling back to the cwd-fed chain');
    }
    const resolution = resolveDeferredVault({
      rootDirs,
      cwd: input.cwd,
      defaultRoot: input.defaultRoot,
      envVault: input.envVault,
      globalDefault: input.globalDefault,
      onSkip: (candidate) =>
        logger.warn({ candidate }, 'ignoring unmarked vault.yaml — no .kmd sibling')
    });
    if (resolution.root === null) {
      throw new Error(
        'no vault resolvable — no client root maps to a vault; pass <vault-root>, set KMD_PROJECT_DIR or WIKI_VAULT, use --default-root, or `kmd config set default_vault <path>`'
      );
    }
    // Pin the env so downstream code agrees, mirroring the CLI entry.
    process.env.WIKI_VAULT = resolution.root;
    const vaultConfig = await loadVaultConfig(resolution.root);
    const db = createDatabase(resolution.root);
    bound = { vaultRoot: resolution.root, db, vaultConfig };
    diag('vault bound', { vault: resolution.root, source: resolution.source });
    logger.info({ vault: resolution.root, source: resolution.source }, 'vault bound');
    resolveBinding(bound);
  };

  mcp.server.oninitialized = () => {
    void bind().catch((err: unknown) => {
      // Fail-loud narrows to bind time in roots-sourced mode: the handshake
      // already happened, so the crash must be explicit, not an unhandled
      // rejection.
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      diag('FATAL at vault bind', { err: msg });
      process.stderr.write(`fatal: vault bind failed: ${msg}\n`);
      process.exit(1);
    });
  };

  // Re-resolution on roots changes is declined: rebinding swaps the index,
  // scope list, and resource content under a live conversation. The vault
  // binds once per server lifetime; a changed workspace takes a new server.
  mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    logger.debug('roots/list_changed received; rebinding declined — vault binds once per server');
  });

  installShutdown(mcp, logger, () => bound?.db ?? null);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('wiki-mcp ready; awaiting initialization to bind the vault');
  diag('ready and connected to transport; vault binds after initialize');
}
