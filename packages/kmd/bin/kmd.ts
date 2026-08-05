#!/usr/bin/env node
import { parseArgs } from 'node:util';

// node:sqlite is the engine's storage bet; on older Node 22.x its
// ExperimentalWarning lands on stderr — the hook diagnostics channel, printed
// per spawned event. Filter that one warning, pass every other through.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') {
    console.error(warning.stack ?? `${warning.name}: ${warning.message}`);
  }
});

const USAGE = `usage: kmd <command> [options]

commands:
  init [<dir>] [-y]        scaffold a fresh vault (no dir: current directory — TTY prompt, or -y)
  sync                     vault → index sync (runs validate first)
  validate [<path>]        deterministic vault checker (default: $WIKI_VAULT)
  mcp [<vault-root>]       start the stdio MCP server (default: $WIKI_VAULT)
  config [<vault-root>]    print vault + index resolution; with no vault, list known vaults
  db reset [<vault-root>]  delete the vault's index (default: $WIKI_VAULT)
  hook <prompt|pretool|posttool|stop|session-start> [<vault-root>] [--scope <s>] [--harness <claude|kiro-ide>] [--triggers <file>]
                           harness gate engine: JSON event on stdin, decision/context on stdout;
                           posttool auto-runs validate + sync after a vault write;
                           stop blocks the handoff once while validate errors hold the sync

options:
  --version   print version
  --help      show this help`;

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
    yes: { type: 'boolean', short: 'y' }
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
    case 'init': {
      const { runInit } = await import('@llm-wiki/cli/cli');
      await runInit(positionals[1], Boolean(values.yes));
      break;
    }
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
    case 'config': {
      applyVaultRoot(1);
      const { runConfig } = await import('@llm-wiki/cli/cli');
      await runConfig();
      break;
    }
    case 'db': {
      const sub = positionals[1];
      if (sub === 'reset') {
        applyVaultRoot(2);
        const { runDbReset } = await import('@llm-wiki/cli/cli');
        await runDbReset();
      } else {
        console.error(sub ? `unknown db subcommand: ${sub}` : 'usage: kmd db reset [<vault-root>]');
        process.exit(2);
      }
      break;
    }
    case 'hook': {
      const sub = positionals[1];
      // Hook runners own their errors and always exit 0 — never falling
      // through to the global handler, whose stderr/exit(1) would fire on
      // every harness event.
      if (sub === 'prompt') {
        const { runHookPrompt } = await import('@llm-wiki/cli/hook');
        await runHookPrompt();
      } else if (sub === 'pretool') {
        const { runHookPretool } = await import('@llm-wiki/cli/hook');
        await runHookPretool();
      } else if (sub === 'posttool') {
        const { runHookPosttool } = await import('@llm-wiki/cli/hook');
        await runHookPosttool();
      } else if (sub === 'stop') {
        const { runHookStop } = await import('@llm-wiki/cli/hook');
        await runHookStop();
      } else if (sub === 'session-start') {
        const { runHookSessionStart } = await import('@llm-wiki/cli/hook');
        await runHookSessionStart();
      } else if (sub) {
        // A typo'd event name is the degraded-engine state the fail-open
        // contract covers, and exit 2 on UserPromptSubmit erases the prompt.
        // Bare `kmd hook` keeps the loud usage error — harness wiring always
        // passes an event, so a missing one is operator misuse.
        console.error(`kmd hook: unknown event: ${sub}`);
      } else {
        console.error(
          'usage: kmd hook <prompt|pretool|posttool|stop|session-start> [<vault-root>] [--scope <scope>] [--harness <claude|kiro-ide>]'
        );
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
      // Same fail-open contract as `kmd hook <bad-event>`: a known event
      // name in the tail marks the invocation as harness wiring, where
      // exit 2 blocks every prompt. Operator typos (`kmd valdate`) carry
      // no event token and keep the loud usage error.
      const tail = positionals[1];
      if (tail === 'prompt' || tail === 'pretool' || tail === 'posttool') {
        console.error(`kmd: unknown command: ${command}`);
        break;
      }
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
    }
  }
}

run().catch((err) => {
  console.error('kmd failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
