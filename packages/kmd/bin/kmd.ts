#!/usr/bin/env node
import { parseArgs } from 'node:util';

const USAGE = `usage: kmd <command> [options]

commands:
  sync                 vault → index sync (runs validate first)
  validate [<path>]    deterministic vault checker (default: $WIKI_VAULT)
  mcp [<vault-root>]   start the stdio MCP server (default: $WIKI_VAULT)
  db reset             delete and recreate the index

options:
  --version   print version
  --help      show this help`;

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' }
  }
});

const command = values.version ? '--version' : values.help ? '--help' : positionals[0];

function applyVaultRoot(positionalIndex: number): void {
  const arg = positionals[positionalIndex];
  if (arg) {
    process.env.WIKI_VAULT = arg;
  }
}

async function run(): Promise<void> {
  switch (command) {
    case 'sync': {
      const { runSyncCommand } = await import('@llm-wiki/cli/cli');
      await runSyncCommand();
      break;
    }
    case 'validate': {
      applyVaultRoot(1);
      const { runValidate } = await import('@llm-wiki/cli/cli');
      await runValidate();
      break;
    }
    case 'mcp': {
      applyVaultRoot(1);
      const { startMcpServer } = await import('@llm-wiki/mcp/start');
      await startMcpServer();
      break;
    }
    case 'db': {
      const sub = positionals[1];
      if (sub === 'reset') {
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        const { unlinkSync } = await import('node:fs');
        const dbPath = join(homedir(), '.kmd', 'db', 'index.db');
        let deleted = false;
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            unlinkSync(dbPath + suffix);
            deleted = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }
        console.log(deleted ? `deleted ${dbPath}` : `${dbPath} does not exist — nothing to reset`);
      } else {
        console.error(sub ? `unknown db subcommand: ${sub}` : 'usage: kmd db reset');
        process.exit(2);
      }
      break;
    }
    case '--version':
    case '-v': {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        version: string;
      };
      console.log(pkg.version);
      break;
    }
    case '--help':
    case '-h':
    case undefined: {
      console.log(USAGE);
      if (command === undefined) process.exit(2);
      break;
    }
    default: {
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
    }
  }
}

run().catch((err) => {
  console.error('kmd failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
