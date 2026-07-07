import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type KindEntry, kindName, type VaultConfig } from '../vault-config.js';

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
  '**Where things go**',
  '',
  "- **Use the matching template** via `wiki://template/{domain}/{kind}` (MCP) or from `templates/` (filesystem). Don't hand-roll frontmatter.",
  '- **Folder name = slug prefix in `projects/`.** `spec/spec-x.md`, `adr/adr-y.md`, `plan/plan-z.md`, `ops/ops-w.md`. Stories use `story-` prefix under `plan/{plan-name}/`.',
  '- **Research is flat.** Articles are `{subject}.md`; sources are `src-{slug}.md`. The topic folder names a *frame*, the article slug names a *subject*. Avoid generic slugs (`architecture.md`, `notes.md`) and slugs that collide with project scopes.',
  '- **Extend before you split.** Prefer sharpening the existing spec, ADR, or article over creating a near-duplicate page. A new page needs a new subject, not a new session.',
  '',
  '**Frontmatter**',
  '',
  '- **`summary` is the retrieval contract.** One sentence stating the page\'s decision or claim, not its topic. Search and `prime` rank by it — "Chose X over Y because Z" surfaces; "About the sync pipeline" sinks.',
  '- **Quote prose-bearing scalars.** `summary: "..."` — unquoted `Word: phrase` patterns break the YAML parser.',
  '- **On any edit, update `updated`.** Never change `created` — it is write-once.',
  '- **Notes have no `kind` field** — implied by location. Sync sets `kind: note`.',
  '- **Reuse existing tags** (visible in `prime` response `top_tags`). No synonyms.',
  '',
  '**Content**',
  '',
  '- **ADR and ops pages are predicate-only.** No definitional preambles for established vocabulary, no narrative, no marketing. The audience is the project team — assume fluency.',
  "- **Spec / ADR edits land inline with the change that surfaces them.** Don't queue corrections in plans — the spec reflects current code at every commit.",
  '',
  '**Linking**',
  '',
  "- **Cross-reference with `[[wikilinks]]`, and link every mention of another vault page** — backlinks are the navigation graph for humans and agents alike. Don't link pages that don't exist yet: dangling links fail validation.",
  '- **ADR supersession is bidirectional**: `superseded_by` on the old ADR + `supersedes` on the new one.',
  "- **Sources convention**: external paths/URLs go inline in body text. Vault-internal `raw/` paths go in frontmatter `sources:` array. Don't mix the two surfaces."
].join('\n');

function buildAuthoringRules(config: VaultConfig): string {
  const parts = [(config.authoring_rules ?? DEFAULT_AUTHORING_RULES).trim()];
  if (config.authoring_rules_extra) parts.push(config.authoring_rules_extra.trim());
  return ['## Authoring rules', '', parts.join('\n\n')].join('\n');
}

const DEFAULT_SYNC_PROTOCOL = [
  'Edit the smallest set of files that reflects the change. ' +
    "A milestone tick is plan-only; don't cascade to index.md unless phase or status changed. " +
    'Controlled-vocabulary edits (`vault.yaml`) need explicit user approval.',
  'After editing wiki pages, run `kmd validate` and fix findings before `kmd sync` — ' +
    'it checks frontmatter shape, vocabulary membership, and link integrity.'
].join('\n');

function buildSyncProtocol(config: VaultConfig): string {
  const parts = [(config.sync_protocol ?? DEFAULT_SYNC_PROTOCOL).trim()];
  if (config.sync_protocol_extra) parts.push(config.sync_protocol_extra.trim());
  return ['## Resync protocol', '', parts.join('\n\n')].join('\n');
}

function buildKindSelector(kinds: ReadonlyArray<KindEntry>): string {
  const lines: string[] = ['## Kind selector', '', '| Signal | Kind | Where |', '|---|---|---|'];
  for (const entry of kinds) {
    const name = kindName(entry);
    const pedagogy = typeof entry === 'string' ? KIND_PEDAGOGY.get(entry) : entry;
    const signal = pedagogy?.signal ?? '—';
    const where = pedagogy?.where ?? '—';
    lines.push(`| ${signal} | **${name}** | ${where} |`);
  }
  const names = kinds.map(kindName);
  const hasNote = names.includes('note');
  const hasAdrAndSpec = names.includes('adr') && names.includes('spec');
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

// The arrow-and-annotation rendering asserts the default lifecycle; a custom
// status list gets a plain enumeration rather than an invented ordering.
const CANONICAL_STATUS_FLOW = ['draft', 'active', 'superseded', 'archived'] as const;

function buildStatusLine(statuses: ReadonlyArray<string>): string {
  const isCanonical =
    statuses.length === CANONICAL_STATUS_FLOW.length &&
    statuses.every((s, i) => s === CANONICAL_STATUS_FLOW[i]);
  return isCanonical
    ? `**Statuses:** ${statuses.join(' → ')} (one-directional; superseded requires superseded_by link)`
    : `**Statuses:** ${statuses.join(', ')}`;
}

function buildVocabulary(config: VaultConfig): string {
  const lines: string[] = [
    '## Controlled vocabulary',
    '',
    `**Kinds:** ${config.kinds.map(kindName).join(', ')}`,
    buildStatusLine(config.statuses),
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
