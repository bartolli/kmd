import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ScopeSchema = z.object({
  repo: z.string().optional(),
  methodology: z.enum(['sdd', 'tdd', 'hybrid']).optional(),
  status: z.string()
});

const VaultConfigSchema = z.object({
  scopes: z.record(z.string(), ScopeSchema),
  kinds: z.array(z.string()),
  statuses: z.array(z.string()),
  methodologies: z.array(z.string()),
  tags: z.object({
    canonical: z.array(z.string()),
    aliases: z.record(z.string(), z.string())
  })
});

export type VaultConfig = z.infer<typeof VaultConfigSchema>;

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
