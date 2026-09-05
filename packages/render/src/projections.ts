import type { McpConfig, PluginManifest, StdioServer } from './package.js';

const CLAUDE_NAMESPACE = 'com.anthropic.claude-code';
const CODEX_NAMESPACE = 'com.openai.codex';

const IDENTITY = ['version', 'description', 'author', 'license', 'keywords'] as const;

function identity(pkg: PluginManifest, out: Record<string, unknown>): void {
  out.name = pkg.name;
  for (const key of IDENTITY) {
    if (pkg[key] !== undefined) out[key] = pkg[key];
  }
}

/**
 * The Claude Code manifest, derived from the root manifest and its
 * `com.anthropic.claude-code` extension: the manifest schema id and the
 * userConfig prompt ride the extension, the identity fields copy from the
 * root, and the field order is the harness's own.
 */
export function claudeManifest(pkg: PluginManifest): string {
  const extension = pkg.extensions?.[CLAUDE_NAMESPACE] ?? {};
  const out: Record<string, unknown> = {};
  if (typeof extension.$schema === 'string') out.$schema = extension.$schema;
  identity(pkg, out);
  if (extension.userConfig !== undefined) out.userConfig = extension.userConfig;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The Codex manifest: identity from the root, the component pointers by
 * rule — skills beside the manifest, the projected `.mcp.json` — and the
 * `interface` block from the `com.openai.codex` extension.
 */
export function codexManifest(pkg: PluginManifest): string {
  const extension = pkg.extensions?.[CODEX_NAMESPACE] ?? {};
  const out: Record<string, unknown> = {};
  identity(pkg, out);
  out.skills = './skills/';
  out.mcpServers = './.mcp.json';
  if (extension.interface !== undefined) out.interface = extension.interface;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The Cortex Code manifest lives at the repo root and carries its skills path,
 * hook wiring, and server registration inline. Identity comes from the root
 * manifest; the skills path is the flavor's; the two inline blocks are
 * whatever the caller supplies.
 */
export function cortexManifest(
  pkg: PluginManifest,
  skillsDir: string,
  blocks: { hooks?: unknown; mcpServers?: unknown }
): string {
  const out: Record<string, unknown> = {};
  out.name = pkg.name;
  for (const key of ['version', 'description', 'author'] as const) {
    if (pkg[key] !== undefined) out[key] = pkg[key];
  }
  out.skills = [`./${skillsDir}`];
  if (blocks.hooks !== undefined) out.hooks = blocks.hooks;
  if (blocks.mcpServers !== undefined) out.mcpServers = blocks.mcpServers;
  return `${JSON.stringify(out, null, 2)}\n`;
}

const MARKETPLACE_SCHEMA = 'https://json.schemastore.org/claude-code-marketplace.json';

/**
 * The Claude Code marketplace file at the repo root: one entry for this
 * plugin, its identity from the root manifest, the marketplace's own name,
 * category, and strictness from the claude extension's `marketplace` block,
 * and the entry's source the claude flavor's directory.
 */
export function marketplaceManifest(pkg: PluginManifest, source: string): string | null {
  const extension = pkg.extensions?.[CLAUDE_NAMESPACE] ?? {};
  const marketplace = extension.marketplace;
  if (typeof marketplace !== 'object' || marketplace === null) return null;
  const { name, category, strict } = marketplace as Record<string, unknown>;
  const entry: Record<string, unknown> = { name: pkg.name, source: `./${source}` };
  for (const key of ['description', 'version', 'author'] as const) {
    if (pkg[key] !== undefined) entry[key] = pkg[key];
  }
  if (category !== undefined) entry.category = category;
  if (strict !== undefined) entry.strict = strict;
  const out: Record<string, unknown> = { $schema: MARKETPLACE_SCHEMA, name };
  if (pkg.author !== undefined) out.owner = pkg.author;
  out.plugins = [entry];
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The placeholder map ([[spec-plugin-projections]] § Server registration):
 * what `${PLUGIN_ROOT}` becomes on a harness, the root signal it appends, and
 * the env it adds. The portable file names one stdio server; a projection
 * rewrites its `args`, `env`, and `cwd` strings and never its `command`.
 */
interface Placement {
  pluginRoot: string;
  rootArgs: string[];
  env: Record<string, string>;
}

const PLUGIN_ROOT = '${PLUGIN_ROOT}';

function expand(value: string, pluginRoot: string): string {
  return value.replaceAll(PLUGIN_ROOT, pluginRoot);
}

function place(server: StdioServer, placement: Placement): StdioServer {
  const out: StdioServer = { type: 'stdio', command: server.command };
  out.args = [
    ...(server.args ?? []).map((arg) => expand(arg, placement.pluginRoot)),
    ...placement.rootArgs
  ];
  if (server.cwd !== undefined) out.cwd = expand(server.cwd, placement.pluginRoot);
  const env = {
    ...Object.fromEntries(
      Object.entries(server.env ?? {}).map(([key, value]) => [
        key,
        expand(value, placement.pluginRoot)
      ])
    ),
    ...placement.env
  };
  if (Object.keys(env).length > 0) out.env = env;
  return out;
}

function stdioServers(mcp: McpConfig): [string, StdioServer][] {
  return Object.entries(mcp.mcpServers).filter(
    (entry): entry is [string, StdioServer] => entry[1].type === 'stdio'
  );
}

/**
 * Claude Code's `.mcp.json`: `${CLAUDE_PLUGIN_ROOT}` for the root, the
 * install-time vault prompt appended as `--default-root` when the claude
 * extension declares `userConfig.vault_path`, the project directory and the
 * log level in env.
 */
export function claudeMcp(pkg: PluginManifest, mcp: McpConfig): string {
  const userConfig = pkg.extensions?.[CLAUDE_NAMESPACE]?.userConfig as
    | Record<string, unknown>
    | undefined;
  const placement: Placement = {
    pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
    rootArgs:
      userConfig?.vault_path !== undefined ? ['--default-root', '${user_config.vault_path}'] : [],
    env: { KMD_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', LOG_LEVEL: 'info' }
  };
  const mcpServers = Object.fromEntries(
    stdioServers(mcp).map(([name, server]) => [name, place(server, placement)])
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * Cortex Code's inline `mcpServers`: the Package sits inside the plugin
 * clone, so the root is the source tree under `${CORTEX_PLUGIN_ROOT}`; no
 * vault root, and the vault, project dir, and log level pass through from
 * the environment with the manifest's `${VAR:-fallback}` interpolation.
 */
export function cortexMcp(mcp: McpConfig, sourceRoot: string): Record<string, StdioServer> {
  const placement: Placement = {
    pluginRoot: `\${CORTEX_PLUGIN_ROOT}/${sourceRoot}`,
    rootArgs: [],
    env: {
      WIKI_VAULT: '${WIKI_VAULT:-}',
      KMD_PROJECT_DIR: '${KMD_PROJECT_DIR:-}',
      LOG_LEVEL: '${WIKI_MCP_LOG_LEVEL:-info}'
    }
  };
  return Object.fromEntries(
    stdioServers(mcp).map(([name, server]) => [name, place(server, placement)])
  );
}

/**
 * Codex's `.mcp.json`: the plugin runs the launcher beside its manifest with
 * `cwd: "."`, and the harness's `env_vars` allowlist — Codex-specific, not
 * `env` — lets the vault, the project directory, and the engine's log level
 * reach the server from the launching shell.
 */
export function codexMcp(mcp: McpConfig): string {
  const placement: Placement = { pluginRoot: '.', rootArgs: [], env: {} };
  const mcpServers = Object.fromEntries(
    stdioServers(mcp).map(([name, server]) => [
      name,
      {
        ...place(server, placement),
        cwd: '.',
        env_vars: ['WIKI_VAULT', 'KMD_PROJECT_DIR', 'LOG_LEVEL']
      }
    ])
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}
