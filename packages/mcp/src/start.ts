import { loadVaultConfig } from '@llm-wiki/db/vault-config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { diag } from './lib/diag.js';
import { createLogger } from './lib/logger.js';
import { buildServer } from './server.js';

export async function startMcpServer(): Promise<void> {
  diag('main entered');

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
    vaultRoot: config.wikiVault,
    db,
    logger,
    vaultConfig
  });
  diag('server built');

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    diag('shutting down', { signal });
    try {
      await mcp.close();
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.once('SIGINT', (s) => void shutdown(s));
  process.once('SIGTERM', (s) => void shutdown(s));

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('wiki-mcp ready');
  diag('ready and connected to transport');
}
