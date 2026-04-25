import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface TemplateSpec {
  /** wiki://template/{domain}/{kind} — `note` collapses to single segment. */
  readonly uri: string;
  /** Human-readable name shown in resources/list. */
  readonly name: string;
  /** Filename in vault/templates/. */
  readonly file: string;
  /** Description shown in resources/list. */
  readonly description: string;
}

/**
 * The vault has 10 fixed templates, mirroring the v2 frontmatter schemas.
 * URI scheme: `wiki://template/{domain}/{kind}` — the agent thinks
 * "I'm authoring a {kind} in the {domain} domain" and the URI matches
 * that mental model. `note` collapses to a single segment because the
 * notes domain has only one kind.
 */
const TEMPLATES: ReadonlyArray<TemplateSpec> = [
  {
    uri: 'wiki://template/project/index',
    name: 'Project index',
    file: 'project-index.md',
    description:
      'Identity card for a project. Frontmatter-heavy: methodology, phase, repo, scope, summary, tags. Short body.'
  },
  {
    uri: 'wiki://template/project/primer',
    name: 'Project primer',
    file: 'project-primer.md',
    description:
      'Human-authored narrative context for a project. Free-form body. Inlined into the prime tool response.'
  },
  {
    uri: 'wiki://template/project/spec',
    name: 'Project spec',
    file: 'project-spec.md',
    description:
      'Specification page — how a system or feature works (state of the world, not decision).'
  },
  {
    uri: 'wiki://template/project/adr',
    name: 'Project ADR',
    file: 'project-adr.md',
    description:
      'Architecture Decision Record — pinned moment of choice. Sections: Status, Context, Decision, Rationale, Consequences.'
  },
  {
    uri: 'wiki://template/project/plan',
    name: 'Project plan',
    file: 'project-plan.md',
    description:
      'Plan for a phase or initiative. Sections: Goal, Scope, Milestones, Dependencies, Status Log.'
  },
  {
    uri: 'wiki://template/project/ops',
    name: 'Project ops',
    file: 'project-ops.md',
    description:
      'Operational runbook — how to run or operate a system. Procedural.'
  },
  {
    uri: 'wiki://template/research/index',
    name: 'Research index',
    file: 'research-index.md',
    description:
      'Topic identity card for a research area. Frontmatter: confidence, source_count, summary, tags.'
  },
  {
    uri: 'wiki://template/research/article',
    name: 'Research article',
    file: 'research-article.md',
    description:
      'Wikipedia-style article about a concept, entity, or system. Original synthesis with sources.'
  },
  {
    uri: 'wiki://template/research/src',
    name: 'Research source',
    file: 'research-src.md',
    description:
      'Summary of an external source (paper, talk, doc) with citation. The only `src-` prefix in research.'
  },
  {
    uri: 'wiki://template/note',
    name: 'Note',
    file: 'note.md',
    description: 'Low-ceremony everyday note. Capture fast, sort later.'
  }
];

/**
 * Register all template resources with the MCP server. Each template is a
 * fixed URI; `resources/read` re-reads the file on every call, so edits to
 * vault/templates/*.md are picked up without restarting the server.
 */
export function registerTemplateResources(mcp: McpServer, vaultRoot: string): void {
  const dir = join(vaultRoot, 'templates');
  for (const tmpl of TEMPLATES) {
    mcp.registerResource(
      tmpl.name,
      tmpl.uri,
      { description: tmpl.description, mimeType: 'text/markdown' },
      async (uri) => {
        const text = await readFile(join(dir, tmpl.file), 'utf8');
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/markdown' as const,
              text
            }
          ]
        };
      }
    );
  }
}
