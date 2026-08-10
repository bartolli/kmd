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

vault resolution (every command): positional > project tier (.kmd/config.local.yaml >
.kmd/config.yaml > vault/vault.yaml > vault.yaml with a .kmd marker beside it,
nearest ancestor of $KMD_PROJECT_DIR or cwd) > --default-root > $WIKI_VAULT >
~/.kmd/config.yaml default_vault

commands:
  init [<dir>] [-y] [--set-default]
                           scaffold a fresh vault (no dir: current directory — TTY prompt, or -y);
                           TTY offers to record it as default_vault, --set-default records it
                           without asking (-y alone never touches the machine default)
  init --local [-y]        scaffold a project vault: <git-root>/vault + <git-root>/.kmd state home
  sync [<vault-root>]      vault → index sync (runs validate first)
  validate [<path>]        deterministic vault checker
  mcp [<vault-root>] [--default-root <path>]
                           start the stdio MCP server; --default-root is the plugin form
                           (config default the project tier may beat); flags are mutually exclusive;
                           no positional and no $KMD_PROJECT_DIR: the vault binds after
                           initialization, from the client's roots/list when it declares the
                           roots capability
  config [<vault-root>]    print resolved vault + winning source; with nothing resolvable, list known vaults
  config <set|get|unset> default_vault [<path>]
                           read/write the global default in ~/.kmd/config.yaml
  db reset [<vault-root>]  delete the vault's index
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
    yes: { type: 'boolean', short: 'y' },
    'default-root': { type: 'string' },
    'set-default': { type: 'boolean' },
    local: { type: 'boolean' }
  }
});

const command = values.version ? '--version' : values.help ? '--help' : positionals[0];

async function run(): Promise<void> {
  switch (command) {
    case 'init': {
      const { runInit } = await import('@llm-wiki/cli/cli');
      await runInit(
        positionals[1],
        Boolean(values.yes),
        Boolean(values.local),
        Boolean(values['set-default'])
      );
      break;
    }
    case 'sync': {
      const { runSyncCommand } = await import('@llm-wiki/cli/cli');
      await runSyncCommand(positionals[1]);
      break;
    }
    case 'validate': {
      const { runValidate } = await import('@llm-wiki/cli/cli');
      await runValidate(positionals[1]);
      break;
    }
    case 'mcp': {
      const positional = positionals[1];
      const defaultRoot =
        typeof values['default-root'] === 'string' ? values['default-root'] : undefined;
      if (positional && defaultRoot !== undefined) {
        console.error('kmd mcp: <vault-root> and --default-root are mutually exclusive');
        process.exit(2);
      }
      const { startMcpServer } = await import('@llm-wiki/mcp/start');
      if (!positional && !process.env.KMD_PROJECT_DIR) {
        // Roots-sourced project-aware mode: the client's roots/list feeds the
        // same tier walk KMD_PROJECT_DIR would, so binding defers to after
        // initialization — fail-loud moves to bind time. A malformed global
        // config still crashes here, before serving.
        const { loadGlobalConfig } = await import('@llm-wiki/db/kmd-config');
        await startMcpServer({
          cwd: process.cwd(),
          defaultRoot,
          envVault: process.env.WIKI_VAULT,
          globalDefault: loadGlobalConfig().default_vault
        });
        break;
      }
      const { resolveCliVault } = await import('@llm-wiki/cli/cli');
      const resolved = resolveCliVault(positional, defaultRoot);
      if (resolved.root === null) {
        console.error(
          'kmd mcp: no vault resolvable — pass <vault-root>, run inside a project vault, set WIKI_VAULT, or `kmd config set default_vault <path>`'
        );
        process.exit(1);
      }
      process.env.WIKI_VAULT = resolved.root;
      await startMcpServer();
      break;
    }
    case 'config': {
      const sub = positionals[1];
      const { runConfig, runConfigGet, runConfigSet, runConfigUnset } = await import(
        '@llm-wiki/cli/cli'
      );
      if (sub === 'set') await runConfigSet(positionals[2], positionals[3]);
      else if (sub === 'get') await runConfigGet(positionals[2]);
      else if (sub === 'unset') await runConfigUnset(positionals[2]);
      else await runConfig(sub);
      break;
    }
    case 'db': {
      const sub = positionals[1];
      if (sub === 'reset') {
        const { runDbReset } = await import('@llm-wiki/cli/cli');
        await runDbReset(positionals[2]);
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
