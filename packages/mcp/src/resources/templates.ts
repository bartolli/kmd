import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILT_IN_KINDS, type VaultConfig } from '@llm-wiki/db/vault-config';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Binding, VaultBinding } from '../binding.js';

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
 * The vault has 11 fixed templates, mirroring the v2 frontmatter schemas
 * (extended with `story` per adr-story-vocabulary-and-triage-fields).
 * URI scheme: `wiki://template/{domain}/{kind}` — the agent thinks
 * "I'm authoring a {kind} in the {domain} domain" and the URI matches
 * that mental model. `note` collapses to a single segment because the
 * notes domain has only one kind.
 */
export const TEMPLATES: ReadonlyArray<TemplateSpec> = [
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
    description: 'Operational runbook — how to run or operate a system. Procedural.'
  },
  {
    uri: 'wiki://template/project/story',
    name: 'Project story',
    file: 'project-story.md',
    description:
      'User story with Gherkin scenarios and inline implementation slices. Lives at plan/{plan-name}/story-N-{slug}.md. Frontmatter carries triage_state, category, blocked_by, parent.'
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
 * Registry entries for custom kinds — object-form `kinds` entries outside the
 * built-in set. Single-segment URI (the `note` precedent: no domain to encode),
 * file by convention at `templates/{name}.md`, the kind's `signal` doubles as
 * the description.
 */
function customTemplates(config: VaultConfig): TemplateSpec[] {
  const specs: TemplateSpec[] = [];
  for (const entry of config.kinds) {
    if (typeof entry === 'string' || BUILT_IN_KINDS.has(entry.name)) continue;
    specs.push({
      uri: `wiki://template/${entry.name}`,
      name: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
      file: `${entry.name}.md`,
      description: entry.signal
    });
  }
  return specs;
}

function registerTemplate(mcp: McpServer, tmpl: TemplateSpec, binding: Binding): void {
  mcp.registerResource(
    tmpl.name,
    tmpl.uri,
    { description: tmpl.description, mimeType: 'text/markdown' },
    async (uri) => {
      const { vaultRoot } = await binding;
      let text: string;
      try {
        text = await readFile(join(vaultRoot, 'templates', tmpl.file), 'utf8');
      } catch (err) {
        throw new Error(`template file missing: templates/${tmpl.file} (${tmpl.uri})`, {
          cause: err
        });
      }
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

function buildIndexText(vaultConfig: VaultConfig): string {
  const indexLines = ['# Wiki Templates', ''];
  for (const tmpl of [...TEMPLATES, ...customTemplates(vaultConfig)]) {
    indexLines.push(`- **${tmpl.name}** — \`${tmpl.uri}\`  `);
    indexLines.push(`  ${tmpl.description}`);
  }
  return indexLines.join('\n');
}

/**
 * Register all template resources with the MCP server. Each template is a
 * fixed URI; `resources/read` re-reads the file on every call, so edits to
 * vault/templates/*.md are picked up without restarting the server.
 *
 * Custom-kind templates come from the vault's config, unknowable before a
 * deferred binding resolves — they register once it does, and the SDK's
 * list_changed notification announces them. A pre-resolved binding registers
 * them synchronously, before the transport connects, as before.
 */
export function registerTemplateResources(mcp: McpServer, binding: Binding): void {
  for (const tmpl of TEMPLATES) {
    registerTemplate(mcp, tmpl, binding);
  }

  const registerCustom = (bound: VaultBinding): void => {
    for (const tmpl of customTemplates(bound.vaultConfig)) {
      registerTemplate(mcp, tmpl, binding);
    }
  };
  if (binding instanceof Promise) void binding.then(registerCustom);
  else registerCustom(binding);

  mcp.registerResource(
    'Template index',
    'wiki://templates',
    {
      description:
        'Index of all wiki templates with URIs and descriptions. Read a specific template via its URI.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      const { vaultConfig } = await binding;
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown' as const,
            text: buildIndexText(vaultConfig)
          }
        ]
      };
    }
  );
}
