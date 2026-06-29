import type { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from './lib/logger.js';
import { registerAuthoringResource } from './resources/authoring.js';
import { registerTemplateResources } from './resources/templates.js';
import { handlePrime, PrimeInputSchema } from './tools/prime.js';
import { handleSearch, SearchInputSchema } from './tools/search.js';
import type { VaultConfig } from './vault-config.js';

export interface BuildServerArgs {
  readonly name: string;
  readonly version: string;
  readonly vaultRoot: string;
  readonly db: DatabaseSync;
  readonly logger: Logger;
  readonly vaultConfig: VaultConfig;
}

export function buildServer(args: BuildServerArgs): McpServer {
  const { name, version, vaultRoot, db, logger, vaultConfig } = args;

  const mcp = new McpServer({ name, version }, { capabilities: { tools: {}, resources: {} } });

  mcp.tool(
    'prime',
    'Orient on a project. Returns a markdown briefing with: identity (scope, phase, methodology, summary), the human-authored primer.md inlined, active ADRs, current plan, page counts, top tags, hub pages (most-linked-to), recent events, cross-scope references, and — when `task` is provided — the top 3 tsvector-ranked relevant pages. Call once at session start. Empty sections are omitted to keep the surface lean.',
    PrimeInputSchema.shape,
    async (input) => {
      logger.debug({ tool: 'prime', input }, 'tool call');
      return handlePrime({ db, vaultRoot, vaultConfig }, input);
    }
  );

  mcp.tool(
    'search',
    'Full-text search across wiki pages via SQLite FTS5. Returns ranked candidates {path, title, kind, summary, score} — never page bodies. The agent reads the returned paths directly from the filesystem.',
    SearchInputSchema.shape,
    async (input) => {
      logger.debug({ tool: 'search', input }, 'tool call');
      return handleSearch({ db }, input);
    }
  );

  registerTemplateResources(mcp, vaultRoot);
  registerAuthoringResource(mcp, vaultRoot, vaultConfig);

  return mcp;
}
