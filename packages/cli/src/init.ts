import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setGlobalConfigValue } from '@llm-wiki/db/kmd-config';
import { configJsonSchema, type VaultConfig } from '@llm-wiki/db/vault-config';
import { stringify } from 'yaml';
import { VAULT_TEMPLATES } from './init-templates.js';

export const SCHEMA_FILE = 'vault.schema.json';

// yaml-language-server reads this modeline and validates vault.yaml against
// the sibling schema file in any modern IDE — machine wiring, not pedagogy.
const SCHEMA_MODELINE = `# yaml-language-server: $schema=./${SCHEMA_FILE}\n`;

/**
 * Write `vault.schema.json` when the running engine's emission differs from
 * what is on disk (absence counts). Returns whether a write happened — the
 * schema is a derived artifact; sync refreshes it so engine upgrades surface
 * as a visible git diff instead of silent IDE/runtime disagreement.
 */
export async function refreshSchemaFile(root: string): Promise<boolean> {
  const path = join(root, SCHEMA_FILE);
  const next = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
  try {
    if ((await readFile(path, 'utf8')) === next) return false;
  } catch {}
  await writeFile(path, next);
  return true;
}

/**
 * The starter vocabulary a fresh vault ships with. Typed against the loader's
 * own schema so a spec change that invalidates it fails compile, not a user's
 * first sync. Scopes stay empty — the first scope is the adopter's naming
 * decision, not the engine's.
 */
export const STARTER_CONFIG: VaultConfig = {
  scopes: {},
  kinds: [
    'project',
    'spec',
    'adr',
    'plan',
    'story',
    'ops',
    'topic',
    'article',
    'src',
    'note',
    'artifact',
    'prompt',
    'intent',
    'glossary'
  ],
  statuses: ['draft', 'active', 'superseded', 'archived'],
  methodologies: ['sdd', 'tdd', 'hybrid'],
  tags: { canonical: [], aliases: {} }
};

export const DOMAIN_DIRS = ['projects', 'research', 'notes'] as const;

/**
 * Scaffold a fresh vault at `dir` and return the resolved root. Throws when
 * the target exists and is non-empty (any entry counts — deterministic, no
 * junk-file allowances). `vault.yaml` is written last: every tool fails loud
 * on its absence, so an interrupted scaffold is inert, never a half-valid
 * vault.
 */
export async function scaffoldVault(dir: string): Promise<string> {
  const root = resolve(dir);
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (entries.includes('vault.yaml')) {
    throw new Error(`already a vault: ${root} (vault.yaml exists)`);
  }
  if (entries.length > 0) {
    throw new Error(
      `target is not empty: ${root}\n  found: ${entries.join(', ')}\n  delete it or pick another directory`
    );
  }

  for (const domain of DOMAIN_DIRS) {
    await mkdir(join(root, domain), { recursive: true });
  }
  await mkdir(join(root, 'templates'), { recursive: true });
  for (const [file, content] of Object.entries(VAULT_TEMPLATES)) {
    await writeFile(join(root, 'templates', file), content);
  }
  await refreshSchemaFile(root);
  await writeFile(join(root, 'vault.yaml'), SCHEMA_MODELINE + stringify(STARTER_CONFIG));
  return root;
}

/**
 * `[y/N]` confirmation on stderr — stdout stays data-clean. Only called when
 * stdin is a TTY; a piped invocation must never hang on a hidden question.
 */
export async function promptYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  defaultYes = false
): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    if (answer === '') return defaultYes;
    return /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

/** Nearest ancestor carrying `.git` (dir or worktree file); null when none. */
function findGitRoot(from: string): string | null {
  let level = resolve(from);
  for (;;) {
    if (existsSync(join(level, '.git'))) return level;
    const parent = dirname(level);
    if (parent === level) return null;
    level = parent;
  }
}

const TIER_GITIGNORE = 'db/\nstate/\nconfig.local.yaml\n';

async function runInitLocal(yes: boolean): Promise<void> {
  const root = findGitRoot(process.cwd()) ?? process.cwd();
  const vaultTarget = join(root, 'vault');
  const kmdDir = join(root, '.kmd');
  if (!yes) {
    if (process.stdin.isTTY) {
      const ok = await promptYesNo(
        `initialize project vault at ${vaultTarget} (state in ${kmdDir})? [Y/n] `,
        process.stdin,
        process.stderr,
        true
      );
      if (!ok) {
        console.error('init: aborted');
        process.exit(1);
      }
    } else {
      console.error('usage: kmd init --local -y  (piped stdin cannot confirm the target)');
      process.exit(2);
    }
  }
  let vaultRoot: string;
  try {
    vaultRoot = await scaffoldVault(vaultTarget);
  } catch (err) {
    console.error(`init: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  await mkdir(kmdDir, { recursive: true });
  const gitignore = join(kmdDir, '.gitignore');
  if (!existsSync(gitignore)) await writeFile(gitignore, TIER_GITIGNORE);
  console.log(`initialized project vault at ${vaultRoot}

  ${kmdDir}/            state home — index and hook state live with the repo
  ${kmdDir}/.gitignore  db/, state/, config.local.yaml stay untracked

every kmd command run inside ${root} now resolves this vault (project tier).
next steps:
  kmd sync    # builds the index at .kmd/db/index.db`);
}

export async function runInit(
  dir: string | undefined,
  yes = false,
  local = false,
  setDefaultFlag = false
): Promise<void> {
  if (local) {
    if (dir !== undefined) {
      console.error('usage: kmd init --local  (the root is the nearest .git ancestor, not chosen)');
      process.exit(2);
    }
    if (setDefaultFlag) {
      console.error(
        'kmd init: --set-default applies to global init only (a project vault resolves by location)'
      );
      process.exit(2);
    }
    await runInitLocal(yes);
    return;
  }
  let target = dir;
  if (!target) {
    if (yes) {
      target = '.';
    } else if (process.stdin.isTTY) {
      const ok = await promptYesNo(`initialize a vault in ${resolve('.')}? [y/N] `);
      if (!ok) {
        console.error('init: aborted');
        process.exit(1);
      }
      target = '.';
    } else {
      console.error('usage: kmd init <dir>  (or --yes to scaffold the current directory)');
      process.exit(2);
    }
  }
  let root: string;
  try {
    root = await scaffoldVault(target);
  } catch (err) {
    console.error(`init: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const templateCount = Object.keys(VAULT_TEMPLATES).length;
  console.log(`initialized empty vault at ${root}

  vault.yaml           starter vocabulary — add your first scope under scopes:
  vault.schema.json    IDE validation via the yaml-language-server modeline
  templates/           ${templateCount} built-in templates (served at wiki://template/...)
  projects/  research/  notes/`);

  // default_vault offer: TTY asks, --set-default accepts explicitly, everything
  // else gets the hint. -y answers only the scaffold confirmation — a scripted
  // scratch init must never rewrite the machine default.
  let setDefault = setDefaultFlag;
  if (!setDefault && !yes && process.stdin.isTTY) {
    setDefault = await promptYesNo(
      `set as default vault in ~/.kmd/config.yaml? [Y/n] `,
      process.stdin,
      process.stderr,
      true
    );
  }
  if (setDefault) {
    setGlobalConfigValue('default_vault', root);
    console.log(`
default_vault: ${root}
next steps:
  kmd mcp    # stdio MCP server (prime, search) — resolves the default`);
  } else {
    console.log(`
next steps:
  kmd config set default_vault ${root}    # make it the machine default
  kmd mcp ${root}    # stdio MCP server (prime, search)`);
  }
}
