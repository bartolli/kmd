import type { PluginManifest } from './package.js';

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
