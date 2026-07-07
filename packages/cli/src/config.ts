import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ScopeSchema = z.object({
  repo: z.string().optional(),
  methodology: z.string().optional(),
  status: z.string()
});

const KindEntrySchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    signal: z.string(),
    where: z.string()
  })
]);

const VaultConfigSchema = z
  .object({
    scopes: z.record(z.string(), ScopeSchema),
    kinds: z.array(KindEntrySchema),
    statuses: z.array(z.string()),
    methodologies: z.array(z.string()),
    tags: z.object({
      canonical: z.array(z.string()),
      aliases: z.record(z.string(), z.string())
    }),
    authoring_rules: z.string().optional(),
    authoring_rules_extra: z.string().optional(),
    sync_protocol: z.string().optional(),
    sync_protocol_extra: z.string().optional()
  })
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
  });

export type KindEntry = z.infer<typeof KindEntrySchema>;
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
 * Load and validate `$vaultRoot/vault.yaml` — the single source of truth for
 * the controlled vocabulary. Throws (fail-loud) when the file is missing or
 * the contents don't satisfy the schema; sync must not run on partial
 * vocabulary.
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
