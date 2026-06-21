import { readFile } from 'node:fs/promises';
import { loadVaultConfig, type VaultConfig } from './config.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  deriveLocation,
  extractWikilinks,
  SCAN_DOMAINS,
  toRelativePath,
  walkMarkdown
} from './sync.js';

export type Severity = 'error' | 'warning';

export interface Finding {
  path: string;
  rule: string;
  severity: Severity;
  message: string;
}

/**
 * A page sync would index: it has a `title` and either a `kind` or lives under
 * notes/ (notes imply kind=note). Title-less narrative/reserved pages (primers,
 * the title-less ontology/alayacare pages) are skipped by sync, so every check
 * except frontmatter-parse is gated on this — validate governs what sync governs.
 */
function isIndexed(relPath: string, data: Record<string, unknown>): boolean {
  if (typeof data.title !== 'string' || data.title.trim() === '') return false;
  if (typeof data.kind === 'string' && data.kind !== '') return true;
  return relPath.startsWith('notes/');
}

/**
 * A reserved `primer.md` (at any level). Title-less, so it is skipped by the
 * indexed-page checks — but it is the agent's first-read surface, so a stale
 * `[[link]]` there must not silently pass the gate. Its body links are checked.
 */
function isPrimer(relPath: string): boolean {
  return relPath === 'primer.md' || relPath.endsWith('/primer.md');
}

// Required-field floor per kind — the set of keys present on 100% of existing
// pages of that kind (corpus-scanned; spec-wiki-validate § Required fields per
// kind). Key-presence, not non-emptiness. Kinds absent here (artifact, prompt,
// glossary-entry, pso-roster) carry no required-field contract.
const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  project: [
    'title',
    'kind',
    'scope',
    'status',
    'summary',
    'tags',
    'updated',
    'methodology',
    'phase',
    'repo'
  ],
  spec: ['title', 'kind', 'scope', 'status', 'summary', 'tags', 'updated', 'sources'],
  adr: ['title', 'kind', 'scope', 'status', 'tags', 'updated'],
  plan: ['title', 'kind', 'scope', 'status', 'summary', 'tags', 'updated'],
  ops: ['title', 'kind', 'scope', 'status', 'summary', 'tags', 'updated'],
  story: [
    'title',
    'kind',
    'scope',
    'status',
    'tags',
    'updated',
    'parent',
    'triage_state',
    'category',
    'blocked_by',
    'sources'
  ],
  topic: ['title', 'kind', 'status', 'summary', 'tags', 'updated', 'confidence'],
  article: ['title', 'kind', 'status', 'tags', 'updated'],
  src: ['title', 'kind', 'topic', 'status', 'summary', 'tags', 'updated'],
  note: ['title', 'tags', 'updated']
};

// Per-kind path patterns (spec-wiki-validate § Folder and slug patterns). Kinds
// absent here have no documented pattern and are exempt (article free naming,
// notes, and the registered-but-undocumented ontology/alayacare kinds).
const FOLDER_PATTERNS: Record<string, RegExp> = {
  spec: /^projects\/[^/]+\/spec\/spec-[^/]+\.md$/,
  adr: /^projects\/[^/]+\/adr\/adr-[^/]+\.md$/,
  ops: /^projects\/[^/]+\/ops\/ops-[^/]+\.md$/,
  plan: /^projects\/[^/]+\/plan\/plan-[^/]+\.md$/,
  story: /^projects\/[^/]+\/plan\/[^/]+\/story-[^/]+\.md$/,
  project: /^projects\/[^/]+\/index\.md$/,
  topic: /^research\/[^/]+\/index\.md$/,
  src: /^research\/[^/]+\/src-[^/]+\.md$/
};

function checkRequiredFields(relPath: string, data: Record<string, unknown>): Finding[] {
  // Notes carry no `kind` key — sync infers `note` from location; mirror that so
  // the note floor is reachable rather than dead.
  const kind =
    typeof data.kind === 'string' && data.kind !== ''
      ? data.kind
      : relPath.startsWith('notes/')
        ? 'note'
        : undefined;
  const required = kind ? REQUIRED_FIELDS[kind] : undefined;
  if (!required) return [];
  const findings: Finding[] = [];
  for (const field of required) {
    if (!Object.hasOwn(data, field)) {
      findings.push({
        path: relPath,
        rule: 'required-fields',
        severity: 'error',
        message: `missing required field "${field}" for kind "${kind}"`
      });
    }
  }
  return findings;
}

function checkFolderSlug(relPath: string, data: Record<string, unknown>): Finding[] {
  const kind = data.kind;
  const pattern = typeof kind === 'string' ? FOLDER_PATTERNS[kind] : undefined;
  if (!pattern || pattern.test(relPath)) return [];
  return [
    {
      path: relPath,
      rule: 'folder-slug',
      severity: 'error',
      message: `path does not match the "${kind}" slug pattern ${pattern.source}`
    }
  ];
}

function checkVocabulary(
  relPath: string,
  data: Record<string, unknown>,
  cfg: VaultConfig
): Finding[] {
  const findings: Finding[] = [];
  const kind = data.kind;
  if (typeof kind === 'string' && !cfg.kinds.includes(kind)) {
    findings.push({
      path: relPath,
      rule: 'kind-vocabulary',
      severity: 'error',
      message: `kind "${kind}" is not in vault.yaml`
    });
  }
  const status = data.status;
  if (typeof status === 'string' && !cfg.statuses.includes(status)) {
    findings.push({
      path: relPath,
      rule: 'status-vocabulary',
      severity: 'error',
      message: `status "${status}" is not in vault.yaml`
    });
  }
  const { scope } = deriveLocation(relPath);
  if (scope !== null && !Object.hasOwn(cfg.scopes, scope)) {
    findings.push({
      path: relPath,
      rule: 'scope-vocabulary',
      severity: 'error',
      message: `scope "${scope}" is not in vault.yaml`
    });
  }
  const methodology = data.methodology;
  if (typeof methodology === 'string' && !cfg.methodologies.includes(methodology)) {
    findings.push({
      path: relPath,
      rule: 'methodology-vocabulary',
      severity: 'error',
      message: `methodology "${methodology}" is not in vault.yaml`
    });
  }
  return findings;
}

/**
 * Path is authoritative for `scope`/`topic`: sync derives them from the path and
 * ignores frontmatter. A frontmatter copy is allowed for readability but must not
 * lie — a mismatch means the label disagrees with where the file actually lives.
 * Fires only where the path defines the value (projects → scope, research → topic)
 * and the frontmatter carries it.
 */
function checkScopePath(relPath: string, data: Record<string, unknown>): Finding[] {
  const { scope, topic } = deriveLocation(relPath);
  const findings: Finding[] = [];
  if (scope !== null && typeof data.scope === 'string' && data.scope !== '' && data.scope !== scope) {
    findings.push({
      path: relPath,
      rule: 'path-authority',
      severity: 'error',
      message: `frontmatter scope "${data.scope}" disagrees with path scope "${scope}"`
    });
  }
  if (topic !== null && typeof data.topic === 'string' && data.topic !== '' && data.topic !== topic) {
    findings.push({
      path: relPath,
      rule: 'path-authority',
      severity: 'error',
      message: `frontmatter topic "${data.topic}" disagrees with path topic "${topic}"`
    });
  }
  return findings;
}

/** A reference's basename target, or null if absent/empty/non-string. */
function refTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : basename(trimmed);
}

/**
 * Basename targets of a reference field that may be scalar or array. `supersedes`
 * and `superseded_by` are list-valued in the wild (one ADR can supersede several),
 * so a scalar-only read would miss them and falsely fail reciprocity.
 */
function refTargets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(refTarget).filter((t): t is string => t !== null);
  }
  const single = refTarget(value);
  return single === null ? [] : [single];
}

/**
 * Strip code regions so `[[...]]`-shaped syntax inside them is not mistaken for a
 * wikilink: fenced ``` blocks (e.g. a bash `if [[ x == y ]]` test) and inline
 * `code` spans (e.g. a `[[wikilink]]` documentation example). Sync's own link
 * extraction is unaffected — its pseudo-links are a separate, pre-existing concern.
 */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

/**
 * Body `[[wikilink]]` dangling check against the basename `refIndex`. Code
 * regions are stripped first (see `stripCode`) so `[[...]]`-shaped syntax inside
 * fences/inline-code is not mistaken for a link. Shared by the indexed-page
 * reference checks and the title-less primer carve-in.
 */
function checkBodyLinks(
  relPath: string,
  body: string,
  refIndex: ReadonlySet<string>
): Finding[] {
  const findings: Finding[] = [];
  for (const link of extractWikilinks(stripCode(body))) {
    if (!link.target.endsWith('.md')) continue;
    if (!refIndex.has(basename(link.target))) {
      findings.push({
        path: relPath,
        rule: 'dangling-link',
        severity: 'error',
        message: `wikilink target "${link.target}" does not resolve`
      });
    }
  }
  return findings;
}

/**
 * Reference resolution against the basename index: body `[[wikilinks]]` to `.md`
 * targets, plus the frontmatter reference fields. Empty values never fire (the
 * empty `supersedes:`/`superseded_by:` template keys are the 52/57). Non-`.md`
 * wikilink targets (images, `.base`, external) are not policed.
 */
function checkReferences(
  relPath: string,
  data: Record<string, unknown>,
  body: string,
  refIndex: ReadonlySet<string>
): Finding[] {
  const findings: Finding[] = checkBodyLinks(relPath, body, refIndex);
  const fieldRefs: string[] = [];
  const parent = refTarget(data.parent);
  if (parent !== null) fieldRefs.push(parent);
  for (const field of ['supersedes', 'superseded_by', 'blocked_by'] as const) {
    fieldRefs.push(...refTargets(data[field]));
  }
  for (const target of fieldRefs) {
    if (!refIndex.has(target)) {
      findings.push({
        path: relPath,
        rule: 'ref-resolves',
        severity: 'error',
        message: `frontmatter reference "${target}" does not resolve`
      });
    }
  }
  return findings;
}

/**
 * Tag policy: only the alias case is enforced, as a non-fatal warning. A full
 * canonical-membership check is deferred — the corpus carries ~211 distinct tags
 * against an 11-entry canonical list, so flagging non-canonical tags would fire
 * on nearly every page (spec-wiki-validate § Tag policy).
 */
function checkTags(relPath: string, data: Record<string, unknown>, cfg: VaultConfig): Finding[] {
  if (!Array.isArray(data.tags)) return [];
  const findings: Finding[] = [];
  for (const tag of data.tags) {
    if (typeof tag === 'string' && Object.hasOwn(cfg.tags.aliases, tag)) {
      findings.push({
        path: relPath,
        rule: 'tag-alias',
        severity: 'warning',
        message: `tag "${tag}" is an alias; use canonical "${cfg.tags.aliases[tag]}"`
      });
    }
  }
  return findings;
}

/** `status: superseded` requires a non-empty `superseded_by` (README §6). */
function checkSupersededLink(relPath: string, data: Record<string, unknown>): Finding[] {
  if (data.status === 'superseded' && refTargets(data.superseded_by).length === 0) {
    return [
      {
        path: relPath,
        rule: 'superseded-needs-link',
        severity: 'error',
        message: 'status is "superseded" but superseded_by is empty'
      }
    ];
  }
  return [];
}

/** Indexed-page checks on already-parsed frontmatter. Pure. */
function checkIndexedPage(
  relPath: string,
  data: Record<string, unknown>,
  body: string,
  cfg: VaultConfig,
  refIndex: ReadonlySet<string>
): Finding[] {
  if (!isIndexed(relPath, data)) return [];
  return [
    ...checkRequiredFields(relPath, data),
    ...checkFolderSlug(relPath, data),
    ...checkVocabulary(relPath, data, cfg),
    ...checkScopePath(relPath, data),
    ...checkReferences(relPath, data, body, refIndex),
    ...checkSupersededLink(relPath, data),
    ...checkTags(relPath, data, cfg)
  ];
}

/**
 * Deterministic checks on a single page's raw content. Pure — no IO. Parses the
 * frontmatter first: a parse failure is the live bug that silently halts sync
 * mid-walk, reported regardless of the page's other fields. Well-formed pages
 * are then subjected to the indexed-page checks (vocabulary, …) against the
 * controlled vocabulary `cfg` and the basename `refIndex` of valid link targets.
 */
export function validatePage(
  relPath: string,
  raw: string,
  cfg: VaultConfig,
  refIndex: ReadonlySet<string>
): Finding[] {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw);
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
  if (isPrimer(relPath)) {
    return checkBodyLinks(relPath, parsed.content, refIndex);
  }
  return checkIndexedPage(relPath, parsed.data, parsed.content, cfg, refIndex);
}

/** Exit-code decision: any error-severity finding fails the run. */
export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** Basename (no extension) of a vault-relative path. */
function basename(relPath: string): string {
  const last = relPath.split('/').pop() ?? relPath;
  return last.replace(/\.md$/, '');
}

export interface PageData {
  path: string;
  data: Record<string, unknown>;
}

/**
 * Cross-page ADR supersession reciprocity: a non-empty `superseded_by: B` on
 * ADR A requires `supersedes: A` on B, and vice-versa. Fires only on non-empty
 * values; a value pointing at a non-existent ADR is a `ref-resolves` error
 * (checked per-page), not a reciprocity error, so unresolved targets are skipped
 * here. (spec-wiki-validate § Supersession.)
 */
export function validateSupersession(pages: PageData[]): Finding[] {
  const adrs = new Map<string, { path: string; supersedes: string[]; supersededBy: string[] }>();
  for (const { path, data } of pages) {
    if (data.kind !== 'adr') continue;
    adrs.set(basename(path), {
      path,
      supersedes: refTargets(data.supersedes),
      supersededBy: refTargets(data.superseded_by)
    });
  }
  const findings: Finding[] = [];
  for (const [name, adr] of adrs) {
    for (const target of adr.supersededBy) {
      const other = adrs.get(target);
      if (other && !other.supersedes.includes(name)) {
        findings.push({
          path: adr.path,
          rule: 'supersession-reciprocal',
          severity: 'error',
          message: `superseded_by "${target}" which does not declare supersedes "${name}"`
        });
      }
    }
    for (const target of adr.supersedes) {
      const other = adrs.get(target);
      if (other && !other.supersededBy.includes(name)) {
        findings.push({
          path: adr.path,
          rule: 'supersession-reciprocal',
          severity: 'error',
          message: `supersedes "${target}" which does not declare superseded_by "${name}"`
        });
      }
    }
  }
  return findings;
}

/** Top-level scope/topic key of a path (`projects/{scope}` or `research/{topic}`), or
 * null for notes/root pages. Two pages "share a scope" iff their keys are equal. */
function locationKey(relPath: string): string | null {
  const seg = relPath.split('/');
  if ((seg[0] === 'projects' || seg[0] === 'research') && seg[1]) {
    return `${seg[0]}/${seg[1]}`;
  }
  return null;
}

export interface LinkPage {
  path: string;
  body: string;
}

/**
 * Cross-page ambiguity warning. A **bare** `[[wikilink]]` whose basename is owned by
 * more than one file is ambiguous only when none of those owners shares the linking
 * page's scope: a same-scope copy resolves it locally (the per-scope `spec-context`/
 * `primer`/`index` pattern), and a path-qualified link (`[[a/b/c]]`) is already
 * disambiguated. Warning, not error — the link resolves, just not uniquely.
 */
export function validateAmbiguousLinks(
  pages: LinkPage[],
  basenameToPaths: ReadonlyMap<string, string[]>
): Finding[] {
  const findings: Finding[] = [];
  for (const { path, body } of pages) {
    const here = locationKey(path);
    for (const link of extractWikilinks(stripCode(body))) {
      if (!link.target.endsWith('.md') || link.target.includes('/')) continue;
      const base = basename(link.target);
      const owners = basenameToPaths.get(base);
      if (!owners || owners.length < 2) continue;
      if (here !== null && owners.some((p) => locationKey(p) === here)) continue;
      findings.push({
        path,
        rule: 'ambiguous-link',
        severity: 'warning',
        message: `bare link "[[${base}]]" is ambiguous — basename owned by ${owners.length} files, none in this scope`
      });
    }
  }
  return findings;
}

/**
 * Walk the vault's content domains (reusing the sync walker), build the basename
 * index of valid reference targets (all on-disk pages, including title-less ones),
 * then aggregate findings across all pages. No Postgres — validation is a
 * pre-sync, read-only pass over the filesystem.
 */
export async function validateVault(root: string): Promise<Finding[]> {
  const cfg = await loadVaultConfig(root);

  // Reference target universe = every on-disk page, including title-less ones and
  // pages outside the scanned domains (raw/, templates/) that are legitimate link
  // targets. Walking from '.' covers the whole vault; dotdirs (.git, .obsidian)
  // are skipped by the walker.
  const all = (await walkMarkdown(root, '.')).map((abs) => ({
    relPath: toRelativePath(root, abs),
    abs
  }));
  // basename → [paths] (the spec's reference-resolution model). `refIndex` (dangling
  // checks: does the basename exist) is its key set; the multimap also backs the
  // cross-page ambiguity warning (does a basename have more than one owner).
  const basenameToPaths = new Map<string, string[]>();
  for (const f of all) {
    const b = basename(f.relPath);
    const owners = basenameToPaths.get(b);
    if (owners) owners.push(f.relPath);
    else basenameToPaths.set(b, [f.relPath]);
  }
  const refIndex = new Set<string>(basenameToPaths.keys());

  // Applicability = only the indexed content domains.
  const files = all.filter((f) => SCAN_DOMAINS.some((d) => f.relPath.startsWith(`${d}/`)));

  const findings: Finding[] = [];
  const pages: PageData[] = [];
  const linkPages: LinkPage[] = [];
  for (const { relPath, abs } of files) {
    const raw = await readFile(abs, 'utf8');
    findings.push(...validatePage(relPath, raw, cfg, refIndex));
    try {
      const parsed = parseFrontmatter(raw);
      pages.push({ path: relPath, data: parsed.data });
      linkPages.push({ path: relPath, body: parsed.content });
    } catch {
      // Parse failure already reported by validatePage; skip in the graph pass.
    }
  }
  findings.push(...validateSupersession(pages));
  findings.push(...validateAmbiguousLinks(linkPages, basenameToPaths));
  return findings;
}
