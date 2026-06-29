import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function readAuthoringRules(vaultRoot: string): Promise<string> {
  try {
    const raw = await readFile(join(vaultRoot, 'CLAUDE.md'), 'utf8');
    const start = raw.indexOf('## Authoring rules');
    if (start === -1) return '';
    const after = raw.indexOf('\n## ', start + 1);
    const section = after === -1 ? raw.slice(start) : raw.slice(start, after);
    return section.trim();
  } catch {
    return '';
  }
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
  vaultRoot: string,
  vaultConfig: VaultConfig
): void {
  mcp.registerResource(
    'Authoring guide',
    'wiki://authoring',
    {
      description:
        'Wiki authoring pedagogy: kind selector, controlled vocabulary, authoring rules, and template URIs. Read before creating or editing wiki pages.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      const rules = await readAuthoringRules(vaultRoot);
      const sections = [
        '# Wiki authoring guide',
        '',
        buildKindSelector(vaultConfig.kinds),
        '',
        buildVocabulary(vaultConfig),
        '',
        '## Templates',
        '',
        'Full index with URIs and descriptions: `wiki://templates`'
      ];
      if (rules) {
        sections.push('', rules);
      }
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
