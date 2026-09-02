import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kindName, loadVaultConfig } from '@llm-wiki/db/vault-config';
import { type Document, isSeq, parseDocument } from 'yaml';
import { DOMAIN_DIRS, refreshSchemaFile, STARTER_CONFIG } from './init.js';
import { VAULT_TEMPLATES } from './init-templates.js';

/**
 * The additive difference between a vault and the starter. `templatesDiffer`
 * is informational: a template the vault holds but edited away from the
 * starter is the human's copy, never a delta.
 */
export interface VaultDelta {
  readonly kinds: string[];
  readonly statuses: string[];
  readonly methodologies: string[];
  readonly templates: string[];
  readonly templatesDiffer: string[];
  readonly domains: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function diffVault(root: string): Promise<VaultDelta> {
  const config = await loadVaultConfig(root);
  const haveKinds = new Set(config.kinds.map(kindName));
  const kinds = STARTER_CONFIG.kinds.map(kindName).filter((k) => !haveKinds.has(k));
  const statuses = STARTER_CONFIG.statuses.filter((s) => !config.statuses.includes(s));
  const methodologies = STARTER_CONFIG.methodologies.filter(
    (m) => !config.methodologies.includes(m)
  );

  const templates: string[] = [];
  const templatesDiffer: string[] = [];
  for (const [file, content] of Object.entries(VAULT_TEMPLATES)) {
    const path = join(root, 'templates', file);
    if (!(await exists(path))) {
      templates.push(file);
      continue;
    }
    if ((await readFile(path, 'utf8')) !== content) templatesDiffer.push(file);
  }

  const domains: string[] = [];
  for (const domain of DOMAIN_DIRS) {
    if (!(await exists(join(root, domain)))) domains.push(domain);
  }

  return { kinds, statuses, methodologies, templates, templatesDiffer, domains };
}

export function isBehind(delta: VaultDelta): boolean {
  return (
    delta.kinds.length +
      delta.statuses.length +
      delta.methodologies.length +
      delta.templates.length +
      delta.domains.length >
    0
  );
}

function appendAll(doc: Document, key: string, values: readonly string[]): void {
  if (values.length === 0) return;
  const seq = doc.get(key);
  if (!isSeq(seq)) throw new Error(`vault.yaml: ${key} is not a sequence`);
  for (const value of values) seq.add(doc.createNode(value));
}

/**
 * Write the delta, additive only. Templates and domain dirs land first and
 * `vault.yaml` last, so an interrupted apply leaves a vault that still loads
 * on its old vocabulary rather than one advertising kinds whose templates
 * are missing. The yaml Document API keeps comments and the modeline.
 */
export async function applyVaultDelta(root: string, delta: VaultDelta): Promise<void> {
  for (const domain of delta.domains) {
    await mkdir(join(root, domain), { recursive: true });
  }
  if (delta.templates.length > 0) await mkdir(join(root, 'templates'), { recursive: true });
  for (const file of delta.templates) {
    const content = VAULT_TEMPLATES[file];
    if (content === undefined) continue;
    await writeFile(join(root, 'templates', file), content);
  }
  await refreshSchemaFile(root);

  if (delta.kinds.length + delta.statuses.length + delta.methodologies.length === 0) return;
  const path = join(root, 'vault.yaml');
  const doc = parseDocument(await readFile(path, 'utf8'));
  appendAll(doc, 'kinds', delta.kinds);
  appendAll(doc, 'statuses', delta.statuses);
  appendAll(doc, 'methodologies', delta.methodologies);
  await writeFile(path, doc.toString());
}

export interface UpgradeResult {
  readonly delta: VaultDelta;
  readonly lines: string[];
  readonly code: 0 | 1;
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function summarizeDelta(delta: VaultDelta): string {
  const parts: string[] = [];
  if (delta.kinds.length > 0) parts.push(count(delta.kinds.length, 'kind', 'kinds'));
  if (delta.statuses.length > 0) parts.push(count(delta.statuses.length, 'status', 'statuses'));
  if (delta.methodologies.length > 0) {
    parts.push(count(delta.methodologies.length, 'methodology', 'methodologies'));
  }
  if (delta.templates.length > 0)
    parts.push(count(delta.templates.length, 'template', 'templates'));
  if (delta.domains.length > 0)
    parts.push(count(delta.domains.length, 'domain dir', 'domain dirs'));
  return parts.join(', ');
}

function itemLines(delta: VaultDelta, prefix: string): string[] {
  return [
    ...delta.kinds.map((k) => `  ${prefix}kind: ${k}`),
    ...delta.statuses.map((s) => `  ${prefix}status: ${s}`),
    ...delta.methodologies.map((m) => `  ${prefix}methodology: ${m}`),
    ...delta.templates.map((t) => `  ${prefix}template: ${t}`),
    ...delta.domains.map((d) => `  ${prefix}domain: ${d}/`)
  ];
}

const CURRENT = 'vault current with the starter';

/**
 * The `kmd init --upgrade` surface: report the delta (exit 1 when behind),
 * or write it with `apply` (exit 0). `differs` lines are informational and
 * never move the exit code.
 */
export async function upgradeVault(
  root: string,
  options: { readonly apply: boolean }
): Promise<UpgradeResult> {
  const delta = await diffVault(root);
  const differs = delta.templatesDiffer.map((t) => `  differs: ${t} (kept)`);
  if (!isBehind(delta)) return { delta, lines: [CURRENT, ...differs], code: 0 };
  if (!options.apply) {
    return {
      delta,
      lines: [
        `vault behind the starter: ${summarizeDelta(delta)}`,
        ...itemLines(delta, ''),
        ...differs,
        'run kmd init --upgrade --apply to write the delta'
      ],
      code: 1
    };
  }
  await applyVaultDelta(root, delta);
  return { delta, lines: [...itemLines(delta, 'applied '), ...differs, CURRENT], code: 0 };
}
