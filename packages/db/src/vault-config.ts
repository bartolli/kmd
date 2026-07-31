import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ScopeSchema = z.strictObject({
  repo: z
    .string()
    .optional()
    .describe(
      'Consumer repo path (~ expands). Load-bearing for kmd hook: the active scope resolves by matching the session cwd against it.'
    ),
  methodology: z.string().optional().describe('Must appear in the methodologies list.'),
  status: z.string().describe('Free string; keep within statuses by convention.')
});

const KindEntrySchema = z.union([
  z.string(),
  z.strictObject({
    name: z.string(),
    signal: z.string().describe('When to pick this kind.'),
    where: z.string().describe('Path pattern pages of this kind follow.')
  })
]);

function isValidRegex(pattern: string): boolean {
  try {
    return Boolean(new RegExp(pattern));
  } catch {
    return false;
  }
}

const WhenSchema = z.union([
  z.string(),
  z.strictObject({
    name: z.enum(['newer-than']),
    fresh: z.array(z.string().min(1)).min(1),
    than: z.array(z.string().min(1)).min(1)
  })
]);

const DedupSchema = z.union([
  z.enum(['session', 'never']),
  z.strictObject({ minutes: z.number().int().positive() })
]);

// Exported: `kmd hook --triggers` validates standalone trigger files with it.
export const TriggerSchema = z
  .strictObject({
    id: z.string().min(1).describe('Unique per scope list; duplicates keep the first occurrence.'),
    on: z.enum(['prompt', 'pretool']),
    enforce: z
      .enum(['inject', 'warn', 'block'])
      .describe('inject: context line · warn: stderr · block: deny with reason.'),
    keywords: z
      .array(z.string().min(1))
      .optional()
      .describe('Word-boundary, porter-stemmed match. Prompt triggers need keywords or intent.'),
    intent: z
      .array(z.string())
      .optional()
      .describe('Case-insensitive regexes over the raw prompt — the stemming escape hatch.'),
    tool: z.string().optional().describe('Exact tool name; pretool matchers AND-compose.'),
    args_match: z.string().optional().describe('Regex over the serialized tool input.'),
    files: z
      .array(z.string().min(1))
      .optional()
      .describe('Globs against the paths the tool touches; pretool triggers only.'),
    when: WhenSchema.optional().describe(
      'Precondition — the gate fires only when it is UNMET. newer-than: the newest page matching fresh must carry frontmatter updated at or after the newest matching than.'
    ),
    text: z.string().optional().describe('Required for inject and warn — the line emitted.'),
    reason: z.string().optional().describe('Required for block — the denial the agent reads.'),
    dedup: DedupSchema.optional().describe(
      'Re-fire policy: session (default, once per session), never, or {minutes: N} for at most once per bucket. Rejected on block triggers — blocks are dedup-exempt.'
    )
  })
  .superRefine((trigger, ctx) => {
    if (trigger.on === 'prompt' && !trigger.keywords?.length && !trigger.intent?.length) {
      ctx.addIssue({
        code: 'custom',
        message: `prompt trigger "${trigger.id}" needs keywords or intent`
      });
    }
    if (
      trigger.on === 'pretool' &&
      trigger.tool === undefined &&
      trigger.args_match === undefined &&
      !trigger.files?.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `pretool trigger "${trigger.id}" needs a tool, args_match, or files matcher`
      });
    }
    if (trigger.on === 'prompt' && trigger.files !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `trigger "${trigger.id}": files applies to pretool triggers only`
      });
    }
    if (trigger.enforce === 'block' && trigger.dedup !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `block trigger "${trigger.id}" may not set dedup — blocks fire on every matching event`
      });
    }
    if (trigger.enforce === 'block' ? trigger.reason === undefined : trigger.text === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          trigger.enforce === 'block'
            ? `block trigger "${trigger.id}" needs a reason`
            : `${trigger.enforce} trigger "${trigger.id}" needs a text`
      });
    }
    const patterns = [...(trigger.intent ?? [])];
    if (trigger.args_match !== undefined) patterns.push(trigger.args_match);
    for (const pattern of patterns) {
      if (!isValidRegex(pattern)) {
        ctx.addIssue({
          code: 'custom',
          message: `trigger "${trigger.id}" has an invalid regex: ${pattern}`
        });
      }
    }
  });

const TriggersSchema = z.record(z.string(), z.array(TriggerSchema));

const VaultConfigSchema = z
  .strictObject({
    scopes: z
      .record(z.string(), ScopeSchema)
      .describe('Scope name → entry; key = directory name under projects/.'),
    kinds: z
      .array(KindEntrySchema)
      .describe(
        'Page kind vocabulary; validate-enforced. Object form adds a kind-selector row to wiki://authoring.'
      ),
    statuses: z.array(z.string()).describe('Page status vocabulary; validate-enforced.'),
    methodologies: z
      .array(z.string())
      .describe('Methodology vocabulary for pages and scope entries.'),
    tags: z.strictObject({
      canonical: z.array(z.string()).describe('Approved tags.'),
      aliases: z
        .record(z.string(), z.string())
        .describe('Alias → canonical; validate warns on alias use.')
    }),
    authoring_rules: z
      .string()
      .optional()
      .describe('Replaces the served § Authoring rules entirely — escape hatch.'),
    authoring_rules_extra: z
      .string()
      .optional()
      .describe('Appended after the served § Authoring rules.'),
    sync_protocol: z
      .string()
      .optional()
      .describe('Replaces the served § Resync protocol entirely — escape hatch.'),
    sync_protocol_extra: z
      .string()
      .optional()
      .describe('Appended after the served § Resync protocol.'),
    triggers: TriggersSchema.optional().describe(
      'Full-replace of the trigger base per scope — escape hatch. "_all" is reserved for triggers_extra.'
    ),
    triggers_extra: TriggersSchema.optional().describe(
      'Appended per scope after the engine defaults; the reserved "_all" key fires in every session.'
    )
  })
  .describe('kmd vault.yaml — controlled vocabulary and gate triggers.')
  .superRefine((config, ctx) => {
    for (const [name, scope] of Object.entries(config.scopes)) {
      if (scope.methodology !== undefined && !config.methodologies.includes(scope.methodology)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scopes', name, 'methodology'],
          message: `"${scope.methodology}" is not in the methodologies list`
        });
      }
    }
    if (config.triggers?._all !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['triggers', '_all'],
        message: '"_all" is reserved for triggers_extra'
      });
    }
    for (const field of ['triggers', 'triggers_extra'] as const) {
      for (const [scope, list] of Object.entries(config[field] ?? {})) {
        const seen = new Set<string>();
        for (const trigger of list) {
          if (seen.has(trigger.id)) {
            ctx.addIssue({
              code: 'custom',
              path: [field, scope],
              message: `duplicate trigger id "${trigger.id}"`
            });
          }
          seen.add(trigger.id);
        }
      }
    }
  });

export type KindEntry = z.infer<typeof KindEntrySchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

/** Kind name of a `kinds` entry — plain string, or the object form's `name`. */
export function kindName(entry: KindEntry): string {
  return typeof entry === 'string' ? entry : entry.name;
}

/**
 * Kinds with built-in engine pedagogy (kind-selector rows; most also carry a
 * served template). An object-form entry with one of these names rewords its
 * selector row only — it never creates custom-template expectations.
 */
export const BUILT_IN_KINDS: ReadonlySet<string> = new Set([
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
  'prompt'
]);

/**
 * JSON Schema (draft-07) emission of the vault.yaml contract, consumed by the
 * yaml-language-server modeline for in-IDE validation and hover docs.
 * Structural only — refinements (trigger conditionals, methodology
 * membership, duplicate ids) stay runtime checks in this module.
 */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(VaultConfigSchema, { target: 'draft-7' }) as Record<string, unknown>;
}

/**
 * Load and validate `$vaultRoot/vault.yaml` — the single source of truth for
 * the controlled vocabulary. Throws (fail-loud) when the file is missing or
 * the contents don't satisfy the schema — unknown keys included, so a typo'd
 * field never silently does nothing. Nothing runs on partial vocabulary:
 * sync aborts and the MCP server refuses to start.
 */
export async function loadVaultConfig(vaultRoot: string): Promise<VaultConfig> {
  const path = join(vaultRoot, 'vault.yaml');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`vault.yaml not found at ${path}`, { cause: err });
  }
  const parsed = VaultConfigSchema.safeParse(parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid vault.yaml at ${path}:\n${issues}`);
  }
  return parsed.data;
}
