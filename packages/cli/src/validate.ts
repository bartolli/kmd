import { readFile } from 'node:fs/promises';
import { parseFrontmatter } from './frontmatter.js';
import { SCAN_DOMAINS, toRelativePath, walkMarkdown } from './sync.js';

export type Severity = 'error' | 'warning';

export interface Finding {
  path: string;
  rule: string;
  severity: Severity;
  message: string;
}

/**
 * Deterministic checks on a single page's raw content. Pure — no IO — so the
 * rule set is unit-testable. Slice 2 covers the frontmatter-parse check: an
 * unquoted `Word: phrase` scalar makes the YAML parser throw, which otherwise
 * silently halts sync mid-walk.
 */
export function validatePage(relPath: string, raw: string): Finding[] {
  try {
    parseFrontmatter(raw);
  } catch (err) {
    return [
      {
        path: relPath,
        rule: 'frontmatter-parse',
        severity: 'error',
        message: err instanceof Error ? err.message : String(err)
      }
    ];
  }
  return [];
}

/** Exit-code decision: any error-severity finding fails the run. */
export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/**
 * Walk the vault's content domains (reusing the sync walker) and aggregate
 * findings across all pages. No Postgres — validation is a pre-sync, read-only
 * pass over the filesystem.
 */
export async function validateVault(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const domain of SCAN_DOMAINS) {
    for (const file of await walkMarkdown(root, domain)) {
      const raw = await readFile(file, 'utf8');
      findings.push(...validatePage(toRelativePath(root, file), raw));
    }
  }
  return findings;
}
