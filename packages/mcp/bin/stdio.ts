#!/usr/bin/env node
import { diag } from '../src/lib/diag.js';

diag('process started', {
  cwd: process.cwd(),
  argv: process.argv,
  node: process.version,
  WIKI_VAULT: process.env.WIKI_VAULT ?? '(unset)',
  WIKI_DB_set: Boolean(process.env.WIKI_DB),
  LOG_LEVEL: process.env.LOG_LEVEL ?? '(unset)',
  PATH: process.env.PATH ?? '(unset)'
});

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/lib/logger.js';
import { buildServer } from '../src/server.js';

diag('imports complete');

async function main(): Promise<void> {
  diag('main entered');

  const config = loadConfig();
  diag('config loaded', { vault: config.wikiVault, level: config.logLevel });

  const logger = createLogger(config.logLevel, config.serverName);
  logger.info(
    { vault: config.wikiVault, serverName: config.serverName, serverVersion: config.serverVersion },
    'starting wiki-mcp on stdio'
  );

  const pool = createPool(config.wikiDb);
  diag('pool created');

  const mcp = buildServer({
    name: config.serverName,
    version: config.serverVersion,
    vaultRoot: config.wikiVault,
    pool,
    logger
  });
  diag('server built');

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    diag('shutting down', { signal });
    try {
      await mcp.close();
      await pool.end();
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

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  diag('FATAL', { err: msg });
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
