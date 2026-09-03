import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Binding } from './binding.js';
import type { Logger } from './lib/logger.js';
import { registerAuthoringResource } from './resources/authoring.js';
import { registerTemplateResources } from './resources/templates.js';
import { handlePrime, PrimeInputSchema } from './tools/prime.js';
import { handleSearch, SearchInputSchema } from './tools/search.js';

export interface BuildServerArgs {
  readonly name: string;
  readonly version: string;
  readonly logger: Logger;
  readonly binding: Binding;
}

export function buildServer(args: BuildServerArgs): McpServer {
  const { name, version, logger, binding } = args;

  // listChanged only in deferred mode: custom-kind templates register after
  // the vault binds, announced via notifications/resources/list_changed. The
  // pre-bound capabilities stay exactly as before.
  const deferred = binding instanceof Promise;
  const mcp = new McpServer(
    { name, version },
    { capabilities: { tools: {}, resources: deferred ? { listChanged: true } : {} } }
  );

  mcp.tool(
    'prime',
    'Orient on a project. Returns a markdown briefing with: identity (scope, phase, methodology, summary), the human-authored primer.md inlined, the glossary Language section under Vocabulary, active ADRs, current plan, page counts, top tags, hub pages (most-linked-to), recent events, cross-scope references, and — when `task` is provided — the top 3 tsvector-ranked relevant pages. Call once at session start. Empty sections are omitted to keep the surface lean.',
    PrimeInputSchema.shape,
    async (input) => {
      logger.debug({ tool: 'prime', input }, 'tool call');
      const { db, vaultRoot, vaultConfig } = await binding;
      return handlePrime({ db, vaultRoot, vaultConfig }, input);
    }
  );

  mcp.tool(
    'search',
    'Full-text search across wiki pages via SQLite FTS5. Returns ranked candidates {path, title, kind, summary, score} — never page bodies. The agent reads the returned paths directly from the filesystem. The authoring protocol is not indexed: read wiki://authoring, wiki://templates, and wiki://template/{domain}/{kind} as resources (or `kmd resource <uri>`) instead of searching for them.',
    SearchInputSchema.shape,
    async (input) => {
      logger.debug({ tool: 'search', input }, 'tool call');
      const { db } = await binding;
      return handleSearch({ db }, input);
    }
  );

  registerTemplateResources(mcp, binding);
  registerAuthoringResource(mcp, binding);

  return mcp;
}
