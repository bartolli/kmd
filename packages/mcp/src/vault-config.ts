import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

// Verbatim mirror of @llm-wiki/cli's src/config.ts — the single definition of a
// valid vault.yaml. Kept byte-identical (schema + error strings) so mcp and
// sync/validate never disagree on what is valid. Collapse both into a shared
// package only when a third separate consumer appears (CLAUDE.md YAGNI rule).

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
 * the contents don't satisfy the schema; the server must not start on partial
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
