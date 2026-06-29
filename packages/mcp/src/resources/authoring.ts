import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultConfig } from '../vault-config.js';

interface KindPedagogy {
  readonly signal: string;
  readonly where: string;
}

const KIND_PEDAGOGY: ReadonlyMap<string, KindPedagogy> = new Map([
  [
    'project',
    {
      signal: 'Identity card for a project scope',
      where: '`projects/{scope}/index.md`'
    }
  ],
  [
    'spec',
    {
      signal: 'How a system works (state of world, not decision)',
      where: '`projects/{scope}/spec/spec-{slug}.md`'
    }
  ],
  [
    'adr',
    {
      signal: 'Decision between alternatives, commits direction',
      where: '`projects/{scope}/adr/adr-{slug}.md`'
    }
  ],
  [
    'plan',
    {
      signal: 'Phase/initiative with milestones and stories',
      where: '`projects/{scope}/plan/plan-{slug}.md`'
    }
  ],
  [
    'story',
    {
      signal: 'User story with Gherkin + slices (child of plan)',
      where: '`projects/{scope}/plan/{plan}/story-N-{slug}.md`'
    }
  ],
  [
    'ops',
    {
      signal: 'Operational runbook, how to run/deploy',
      where: '`projects/{scope}/ops/ops-{slug}.md`'
    }
  ],
  [
    'topic',
    {
      signal: 'Identity card for a research area',
      where: '`research/{topic}/index.md`'
    }
  ],
  [
    'article',
    {
      signal: 'Original synthesis about a concept/entity',
      where: '`research/{topic}/{slug}.md`'
    }
  ],
  [
    'src',
    {
      signal: 'Summary of external source with citation',
      where: '`research/{topic}/src-{slug}.md`'
    }
  ],
  ['note', { signal: 'Low-ceremony capture, sort later', where: '`notes/{slug}.md`' }],
  [
    'artifact',
    {
      signal: 'Deployable configuration (scope-specific, versioned)',
      where: '`projects/{scope}/ops/{deployment}/{slug}.md`'
    }
  ],
  [
    'prompt',
    {
      signal: 'LLM prompt template (scope-specific, versioned)',
      where: '`projects/{scope}/ops/{deployment}/prompts/{role}/{slug}.md`'
    }
  ]
]);

const DEFAULT_AUTHORING_RULES = [
  '- **Use the matching template** via `wiki://template/{domain}/{kind}` (MCP) or from `templates/` (filesystem). Don\'t hand-roll frontmatter.',
  '- **Quote prose-bearing frontmatter scalars.** `summary: "..."` — unquoted `Word: phrase` patterns break the YAML parser.',
  '- **On any edit, update the frontmatter `updated` field.**',
  '- **Folder name = slug prefix in `projects/`.** `spec/spec-x.md`, `adr/adr-y.md`, `plan/plan-z.md`, `ops/ops-w.md`. Stories use `story-` prefix under `plan/{plan-name}/`.',
  '- **Research is flat.** Articles are `{subject}.md`; sources are `src-{slug}.md`. Avoid generic slugs (`architecture.md`, `notes.md`).',
  '- **Notes have no `kind` field** — implied by location. Sync sets `kind: note`.',
  '- **Reuse existing tags** (visible in `prime` response `top_tags`). No synonyms.',
  '- **ADR supersession is bidirectional**: `superseded_by` on the old ADR + `supersedes` on the new one.',
  '- **Sources convention**: external paths/URLs go inline in body text. Vault-internal `raw/` paths go in frontmatter `sources:` array. Don\'t mix the two surfaces.',
  '- **Spec / ADR edits land inline with the slice that surfaces them.** Don\'t queue corrections in plans. The spec must reflect current code at every commit.'
].join('\n');

function buildAuthoringRules(config: VaultConfig): string {
  return [
    '## Authoring rules',
    '',
    config.authoring_rules ?? DEFAULT_AUTHORING_RULES
  ].join('\n');
}

const DEFAULT_SYNC_PROTOCOL =
  'Edit the smallest set of files that reflects the change. ' +
  'A milestone tick is plan-only; don\'t cascade to index.md unless phase or status changed. ' +
  'Controlled-vocabulary edits need explicit user approval.';

function buildSyncProtocol(config: VaultConfig): string {
  return [
    '## Resync protocol',
    '',
    config.sync_protocol ?? DEFAULT_SYNC_PROTOCOL
  ].join('\n');
}

function buildKindSelector(kinds: ReadonlyArray<string>): string {
  const lines: string[] = ['## Kind selector', '', '| Signal | Kind | Where |', '|---|---|---|'];
  for (const kind of kinds) {
    const pedagogy = KIND_PEDAGOGY.get(kind);
    const signal = pedagogy?.signal ?? '—';
    const where = pedagogy?.where ?? '—';
    lines.push(`| ${signal} | **${kind}** | ${where} |`);
  }
  const hasNote = kinds.includes('note');
  const hasAdrAndSpec = kinds.includes('adr') && kinds.includes('spec');
  if (hasNote || hasAdrAndSpec) {
    const hints: string[] = [];
    if (hasNote) hints.push('If none fits → note.');
    if (hasAdrAndSpec) {
      hints.push(
        'If torn between adr and spec → does it record a choice? adr. Does it describe how things work? spec.'
      );
    }
    lines.push('', hints.join(' '));
  }
  return lines.join('\n');
}

function buildVocabulary(config: VaultConfig): string {
  const lines: string[] = [
    '## Controlled vocabulary',
    '',
    `**Kinds:** ${config.kinds.join(', ')}`,
    `**Statuses:** ${config.statuses.join(' → ')} (one-directional; superseded requires superseded_by link)`,
    `**Methodologies:** ${config.methodologies.join(', ')}`,
    `**Canonical tags:** ${config.tags.canonical.join(', ')}`
  ];
  const aliases = Object.entries(config.tags.aliases);
  if (aliases.length > 0) {
    lines.push(`**Tag aliases:** ${aliases.map(([a, c]) => `${a} → ${c}`).join(', ')}`);
  }
  return lines.join('\n');
}

export function registerAuthoringResource(
  mcp: McpServer,
  _vaultRoot: string,
  vaultConfig: VaultConfig
): void {
  mcp.registerResource(
    'Authoring guide',
    'wiki://authoring',
    {
      description:
        'Wiki authoring pedagogy: kind selector, controlled vocabulary, authoring rules, resync protocol, and template URIs. Read before creating or editing wiki pages.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      const sections = [
        '# Wiki authoring guide',
        '',
        buildKindSelector(vaultConfig.kinds),
        '',
        buildVocabulary(vaultConfig),
        '',
        '## Templates',
        '',
        'Full index with URIs and descriptions: `wiki://templates`',
        '',
        buildAuthoringRules(vaultConfig),
        '',
        buildSyncProtocol(vaultConfig)
      ];
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown' as const,
            text: sections.join('\n')
          }
        ]
      };
    }
  );
}
