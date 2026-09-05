import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { validatePackage } from './package.js';
import {
  claudeManifest,
  claudeMcp,
  codexManifest,
  codexMcp,
  cortexManifest,
  cortexMcp,
  marketplaceManifest
} from './projections.js';
import { type DialectConfig, transformCoco, transformCodex } from './transform.js';

export type Dialect =
  | { kind: 'claude' }
  | { kind: 'codex'; slashAliases: string[]; replacements: [string, string][] }
  | { kind: 'coco'; slashAliases: string[]; replacements: [string, string][] };

export interface FlavorConfig {
  dest: string;
  dialect: Dialect;
}

export interface ExactEntry {
  path: string;
  flavors?: string[];
}

// A site the harness-name lints skip: a literal phrase, or a whole section
// named by its heading line (through the next heading of the same or a higher
// level). An entry that stops matching the source goes stale loudly: the
// lint fires.
export type LintAllow = string | { section: string };

export interface RenderManifest {
  sourceRoot: string;
  flavors: Record<string, FlavorConfig>;
  shared: { exact: ExactEntry[]; rendered: string[] };
  lintAllow?: LintAllow[];
  // JSON file whose "version" field stamps metadata.version into every
  // rendered SKILL.md — skills travel standalone, so provenance rides the
  // folder. The renderer owns the field; sources must not declare metadata.
  versionSource?: string;
}

export interface RenderResult {
  problems: string[];
  mismatches: string[];
  written: number;
}

function skillNames(sourceRoot: string): string[] {
  const skillsDir = join(sourceRoot, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Agent Skills limits, on the source: name = folder, lowercase/numbers/hyphens
// <= 64; description <= 1024 chars measured on the YAML-parsed value. A
// conformant client installs the source, so the source is what must conform.
function assertSkillCaps(rel: string, source: string): string[] {
  const match = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (!match) return [];
  const folder = match[1] as string;
  const fmMatch = source.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [`${rel}: no YAML frontmatter to verify against the Agent Skills caps`];
  let fm: { name?: unknown; description?: unknown };
  try {
    fm = parse(fmMatch[1] as string) as { name?: unknown; description?: unknown };
  } catch {
    return [`${rel}: frontmatter does not parse as YAML`];
  }
  const problems: string[] = [];
  if (fm.name !== folder) {
    problems.push(`${rel}: name '${String(fm.name)}' must match folder '${folder}'`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(folder) || folder.length > 64) {
    problems.push(`${rel}: folder '${folder}' breaks the lowercase-hyphen <=64 rule`);
  }
  const desc = typeof fm.description === 'string' ? fm.description.trimEnd() : '';
  if (desc.length > 1024) {
    problems.push(`${rel}: description is ${desc.length} chars — the Agent Skills cap is 1024`);
  }
  return problems;
}

const SKILL_MD = /^skills\/[^/]+\/SKILL\.md$/;

// Harness names and harness-owned instruction files a neutral source never
// names outside an allowed site. Longest first, so `Claude Code` reports once.
const HARNESS_NAMES = [
  'Claude Code',
  'Cortex Code',
  'CLAUDE.md',
  'CORTEX.md',
  'Claude',
  'Codex',
  'CoCo',
  'Cortex',
  'Kiro'
];
const HARNESS_NAME = new RegExp(
  `(?<![\\w.])(${HARNESS_NAMES.map((n) => n.replace(/[.]/g, '\\.')).join('|')})(?!\\w)`,
  'g'
);

function lintHarnessNames(rel: string, text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(HARNESS_NAME)) seen.add(m[1] as string);
  return [...seen].map(
    (name) =>
      `${rel}: harness name \`${name}\` — the source is harness-neutral; reword it, or list the site in lintAllow`
  );
}

// Skill invocation tokens must name a skill folder or a dialect's slash
// alias: `$name` — the codex and coco form, the shape the manifest's prompts
// and the extension dirs' prose carry — in every Package markdown and JSON
// file, and backticked `/name` — the source form — in skill bodies, where a
// harness's own slash commands sit only inside lintAllow sites. A retired
// skill's token otherwise survives in chrome the body lints never read.
// `$schema` is JSON's, not a skill.
const DOLLAR_TOKEN = /(?<![\w$])\$([a-z][a-z0-9-]*)/g;
const SLASH_TOKEN = /`\/([a-z][a-z0-9-]*)`/g;

function lintSkillTokens(
  rel: string,
  text: string,
  known: ReadonlySet<string>,
  slashForm: boolean
): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(DOLLAR_TOKEN)) {
    const name = m[1] as string;
    if (name !== 'schema' && !known.has(name)) seen.add(`$${name}`);
  }
  if (slashForm) {
    for (const m of text.matchAll(SLASH_TOKEN)) {
      const name = m[1] as string;
      if (!known.has(name)) seen.add(`/${name}`);
    }
  }
  return [...seen].map(
    (token) =>
      `${rel}: skill token \`${token}\` names no Package skill — rename it, or add the skill`
  );
}

const TOKEN_LINT_FILES = /\.(md|json)$/;

function withoutSection(text: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = (lines[i] as string).match(/^(#+) /);
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

function withoutAllowed(text: string, lintAllow: LintAllow[]): string {
  let out = text;
  for (const allowed of lintAllow) {
    out =
      typeof allowed === 'string'
        ? out.replaceAll(allowed, '')
        : withoutSection(out, allowed.section);
  }
  return out;
}

function stampVersion(text: string, version: string): string {
  const fm = text.match(/^---\n[\s\S]*?\n---/);
  if (!fm) return text;
  const head = fm[0].slice(0, -4);
  return `${head}\nmetadata:\n  version: "${version}"\n---${text.slice(fm[0].length)}`;
}

// Harnesses that read `CLAUDE.md` as a project-instructions file. A surviving
// `CLAUDE.md` is drift everywhere else; here it is the correct instruction.
// CoCo's reader list is `AGENTS.md, CLAUDE.md, CORTEX.md, RULES.md, .cursorrules`.
const CLAUDE_MD_READERS = new Set<Dialect['kind']>(['claude', 'coco']);

function applyDialect(text: string, dialect: Dialect, names: string[]): string {
  // The source is harness-neutral; the claude flavor renders it as is.
  if (dialect.kind === 'claude') return text;
  const cfg: DialectConfig = {
    slashNames: [...names, ...dialect.slashAliases],
    replacements: dialect.replacements
  };
  return dialect.kind === 'codex' ? transformCodex(text, cfg) : transformCoco(text, cfg);
}

// Repo-root placements: a managed Cortex install resolves its manifest at the
// clone root, and the Claude marketplace serves from the repository root.
const CORTEX_MANIFEST = '.cortex-plugin/plugin.json';
const MARKETPLACE = '.claude-plugin/marketplace.json';

// The Package launcher; a flavor's hook wrapper is a copy of it.
const LAUNCHER = 'scripts/run-kmd.mjs';

// One Extension dir per harness, named by the vendor's reverse domain, holding
// that harness's hook wiring and chrome; the renderer places each file where
// the harness reads it. A file the map does not name is not placed.
// A destination starting with `/` is repo-root-relative; the rest land in the
// flavor's dest. `wrapper` names where a copy of the launcher goes; a harness
// with its own resolver lists it under `files` instead.
interface ExtensionDir {
  kind: Dialect['kind'] | null;
  files: Record<string, string>;
  wrapper?: string;
}

const EXTENSION_DIRS: Record<string, ExtensionDir> = {
  'com.anthropic.claude-code': {
    kind: 'claude',
    files: { 'hooks.json': 'hooks/hooks.json', 'README.md': 'README.md' },
    wrapper: 'hooks/run-kmd-hook.mjs'
  },
  'com.openai.codex': {
    kind: 'codex',
    files: { 'hooks.json': 'hooks/hooks.json', 'README.md': 'README.md' },
    wrapper: 'hooks/run-kmd-hook.mjs'
  },
  // hooks.json here is the manifest's inline `hooks` block, not a placed file
  'com.snowflake.cortex': {
    kind: 'coco',
    files: {
      'README.md': 'README.md',
      'run-kmd-hook.mjs': 'hooks/run-kmd-hook.mjs',
      'activation.md': '/.cortex-plugin/activation.md'
    }
  },
  // Kiro reads the portable fields; its directory carries the hook-file
  // template the wiki skill's onboarding writes, placed by no flavor
  'dev.kiro': { kind: null, files: {} }
};

const PACKAGE_DIRS = new Set(['skills', 'scripts']);

// The Package root is the standard's layout plus the launcher: anything else
// is a check error, so a stray directory never ships to a conformant client.
function lintPackageLayout(sourceRoot: string): string[] {
  const problems: string[] = [];
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || PACKAGE_DIRS.has(entry.name)) continue;
    if (!entry.name.includes('.')) {
      problems.push(
        `${entry.name}/: not a Package directory — skills/, scripts/, or an extension namespace`
      );
    } else if (!(entry.name in EXTENSION_DIRS)) {
      problems.push(
        `${entry.name}/: unknown extension namespace — the renderer places nothing from it`
      );
    }
  }
  return problems;
}

function placeExtension(
  repoRoot: string,
  sourceRoot: string,
  dest: string,
  namespace: string,
  extension: ExtensionDir,
  payload: Map<string, string | Buffer>
): void {
  for (const [file, target] of Object.entries(extension.files)) {
    const src = join(sourceRoot, namespace, file);
    if (!existsSync(src)) continue;
    const key = target.startsWith('/')
      ? relative(join(repoRoot, dest), join(repoRoot, target.slice(1)))
      : target;
    payload.set(key, readFileSync(src));
  }
  const launcher = join(sourceRoot, LAUNCHER);
  if (extension.wrapper !== undefined && existsSync(launcher)) {
    payload.set(extension.wrapper, readFileSync(launcher));
  }
}

function extensionHooks(sourceRoot: string, namespace: string): unknown {
  const path = join(sourceRoot, namespace, 'hooks.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function buildPayloads(
  repoRoot: string,
  manifest: RenderManifest
): { payloads: Map<string, Map<string, string | Buffer>>; problems: string[] } {
  const sourceRoot = join(repoRoot, manifest.sourceRoot);
  const names = skillNames(sourceRoot);
  const pkg = validatePackage(sourceRoot);
  const problems: string[] = [...pkg.problems, ...lintPackageLayout(sourceRoot)];
  const payloads = new Map<string, Map<string, string | Buffer>>();

  let stampVer: string | null = null;
  if (manifest.versionSource) {
    try {
      const raw = JSON.parse(readFileSync(join(repoRoot, manifest.versionSource), 'utf8')) as {
        version?: unknown;
      };
      if (typeof raw.version === 'string') stampVer = raw.version;
      else problems.push(`versionSource ${manifest.versionSource}: no string "version" field`);
      if (stampVer !== null && pkg.manifest !== null && pkg.manifest.version !== stampVer) {
        problems.push(
          `plugin.json: version ${pkg.manifest.version} differs from versionSource ${stampVer} — one version ships everywhere`
        );
      }
    } catch {
      problems.push(`versionSource ${manifest.versionSource}: unreadable or invalid JSON`);
    }
    for (const rel of manifest.shared.rendered) {
      if (!SKILL_MD.test(rel)) continue;
      const src = readFileSync(join(sourceRoot, rel), 'utf8');
      const fm = src.match(/^---\n([\s\S]*?)\n---/);
      if (fm && /^metadata:/m.test(fm[1] as string)) {
        problems.push(
          `${rel}: source declares a metadata block — the renderer owns metadata.version, remove it`
        );
      }
    }
  }

  const known = new Set<string>(names);
  for (const flavor of Object.values(manifest.flavors)) {
    if (flavor.dialect.kind !== 'claude') {
      for (const alias of flavor.dialect.slashAliases) known.add(alias);
    }
  }
  const sources = new Map<string, string>();
  for (const rel of manifest.shared.rendered) {
    const source = readFileSync(join(sourceRoot, rel), 'utf8');
    sources.set(rel, source);
    const lintable = withoutAllowed(source, manifest.lintAllow ?? []);
    problems.push(...lintHarnessNames(rel, lintable));
    problems.push(...lintSkillTokens(rel, lintable, known, rel.startsWith('skills/')));
    problems.push(...assertSkillCaps(rel, source));
  }
  for (const entry of manifest.shared.exact) {
    if (!entry.path.startsWith('skills/')) continue;
    const source = readFileSync(join(sourceRoot, entry.path), 'utf8');
    const lintable = withoutAllowed(source, manifest.lintAllow ?? []);
    problems.push(...lintHarnessNames(entry.path, lintable));
    problems.push(...lintSkillTokens(entry.path, lintable, known, true));
  }
  for (const rel of ['plugin.json', 'README.md']) {
    const abs = join(sourceRoot, rel);
    if (existsSync(abs)) {
      problems.push(...lintSkillTokens(rel, readFileSync(abs, 'utf8'), known, false));
    }
  }
  for (const namespace of Object.keys(EXTENSION_DIRS)) {
    for (const abs of walkFiles(join(sourceRoot, namespace))) {
      if (!TOKEN_LINT_FILES.test(abs)) continue;
      const rel = relative(sourceRoot, abs);
      problems.push(...lintSkillTokens(rel, readFileSync(abs, 'utf8'), known, false));
    }
  }

  for (const [name, flavor] of Object.entries(manifest.flavors)) {
    const payload = new Map<string, string | Buffer>();
    for (const rel of manifest.shared.rendered) {
      const source = sources.get(rel) as string;
      let out = applyDialect(source, flavor.dialect, names);
      if (stampVer !== null && SKILL_MD.test(rel)) {
        out = stampVersion(out, stampVer);
      }
      const lintable = withoutAllowed(out, manifest.lintAllow ?? []);
      if (!CLAUDE_MD_READERS.has(flavor.dialect.kind) && lintable.includes('CLAUDE.md')) {
        problems.push(
          `${name}: ${rel}: \`CLAUDE.md\` survives the ${name} transform — extend the manifest replacements`
        );
      }
      payload.set(rel, out);
    }
    for (const entry of manifest.shared.exact) {
      if (entry.flavors && !entry.flavors.includes(name)) continue;
      payload.set(entry.path, readFileSync(join(sourceRoot, entry.path)));
    }
    for (const [namespace, extension] of Object.entries(EXTENSION_DIRS)) {
      if (extension.kind === flavor.dialect.kind) {
        placeExtension(repoRoot, sourceRoot, flavor.dest, namespace, extension, payload);
      }
    }
    if (flavor.dialect.kind === 'claude' && pkg.manifest !== null) {
      payload.set('.claude-plugin/plugin.json', claudeManifest(pkg.manifest));
      if (pkg.mcp !== null) payload.set('.mcp.json', claudeMcp(pkg.manifest, pkg.mcp));
      const marketplace = marketplaceManifest(pkg.manifest, flavor.dest);
      if (marketplace !== null) {
        payload.set(
          relative(join(repoRoot, flavor.dest), join(repoRoot, MARKETPLACE)),
          marketplace
        );
      }
    }
    if (flavor.dialect.kind === 'codex' && pkg.manifest !== null) {
      payload.set('.codex-plugin/plugin.json', codexManifest(pkg.manifest));
      if (pkg.mcp !== null) payload.set('.mcp.json', codexMcp(pkg.mcp));
    }
    if (flavor.dialect.kind === 'coco' && pkg.manifest !== null) {
      const hooks = extensionHooks(sourceRoot, 'com.snowflake.cortex');
      const blocks = {
        ...(hooks !== undefined && { hooks }),
        ...(pkg.mcp !== null && { mcpServers: cortexMcp(pkg.mcp, manifest.sourceRoot) })
      };
      payload.set(
        relative(join(repoRoot, flavor.dest), join(repoRoot, CORTEX_MANIFEST)),
        cortexManifest(pkg.manifest, `${flavor.dest}/skills`, blocks)
      );
    }
    payloads.set(name, payload);
  }

  return { payloads, problems };
}

export function render(
  repoRoot: string,
  manifest: RenderManifest,
  mode: 'write' | 'check'
): RenderResult {
  const { payloads, problems } = buildPayloads(repoRoot, manifest);
  const mismatches: string[] = [];
  let written = 0;

  if (problems.length > 0) {
    return { problems, mismatches, written };
  }

  for (const [name, flavor] of Object.entries(manifest.flavors)) {
    const dest = join(repoRoot, flavor.dest);
    const payload = payloads.get(name) ?? new Map<string, string | Buffer>();

    if (mode === 'write') {
      rmSync(join(dest, 'skills'), { recursive: true, force: true });
      for (const [rel, out] of payload) {
        const target = join(dest, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, out);
        written += 1;
      }
      continue;
    }

    for (const [rel, out] of payload) {
      const target = join(dest, rel);
      if (!existsSync(target)) {
        mismatches.push(`${name}: ${rel}: missing from ${flavor.dest}`);
        continue;
      }
      const expected = typeof out === 'string' ? Buffer.from(out, 'utf8') : out;
      if (!readFileSync(target).equals(expected)) {
        mismatches.push(`${name}: ${rel}: differs from rendered output`);
      }
    }
    for (const abs of walkFiles(join(dest, 'skills'))) {
      const rel = relative(dest, abs);
      if (!payload.has(rel)) {
        mismatches.push(`${name}: ${rel}: not in rendered output (stale)`);
      }
    }
  }

  return { problems, mismatches, written };
}
