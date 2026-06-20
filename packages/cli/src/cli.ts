import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runSync } from './sync.js';
import { hasErrors, validateVault } from './validate.js';

export type Command = 'sync' | 'validate';

export type CliResolution = { kind: 'run'; command: Command } | { kind: 'error'; message: string };

/**
 * Resolve a `wiki <command>` invocation to the command to run, or a usage
 * error. Pure — no side effects — so the routing is testable without executing
 * the (Postgres-touching) command. `argv` is `process.argv.slice(2)`.
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

function vaultRoot(): string {
  const root = process.env.WIKI_VAULT;
  if (!root) {
    console.error('WIKI_VAULT is not set');
    process.exit(1);
  }
  return root;
}

async function runValidate(): Promise<void> {
  const findings = await validateVault(vaultRoot());
  for (const f of findings) {
    console.error(`${f.severity}: ${f.path} [${f.rule}] ${f.message}`);
  }
  console.log(`validate: ${findings.length} finding(s)`);
  process.exit(hasErrors(findings) ? 1 : 0);
}

async function main(): Promise<void> {
  const resolution = resolveCli(process.argv.slice(2));
  if (resolution.kind === 'error') {
    console.error(resolution.message);
    process.exit(1);
  }
  if (resolution.command === 'sync') {
    await runSync();
  } else {
    await runValidate();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error('wiki failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
