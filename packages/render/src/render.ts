import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { type DialectConfig, transformCodex, transformKiro } from './transform.js';

export type Dialect =
  | { kind: 'identity' }
  | { kind: 'codex'; slashAliases: string[]; replacements: [string, string][] }
  | { kind: 'kiro'; replacements: [string, string][] };

export interface FlavorConfig {
  dest: string;
  dialect: Dialect;
}

export interface ExactEntry {
  path: string;
  flavors?: string[];
}

export interface RenderManifest {
  sourceRoot: string;
  flavors: Record<string, FlavorConfig>;
  shared: { exact: ExactEntry[]; rendered: string[] };
  // Literals allowed to survive dialect transforms — harness-neutral content
  // (e.g. cross-harness comparison tables) that legitimately names CLAUDE.md.
  // An entry that stops matching the source goes stale loudly: the lint fires.
  lintAllow?: string[];
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

// Kiro's Agent Skills limits: name = folder, lowercase/numbers/hyphens <= 64;
// description <= 1024 chars measured on the YAML-parsed value.
function assertKiroSkillCaps(rel: string, rendered: string): string[] {
  const match = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (!match) return [];
  const folder = match[1] as string;
  const fmMatch = rendered.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [`kiro: ${rel}: no YAML frontmatter to verify against skill caps`];
  let fm: { name?: unknown; description?: unknown };
  try {
    fm = parse(fmMatch[1] as string) as { name?: unknown; description?: unknown };
  } catch {
    return [`kiro: ${rel}: frontmatter does not parse as YAML`];
  }
  const problems: string[] = [];
  if (fm.name !== folder) {
    problems.push(`kiro: ${rel}: name '${String(fm.name)}' must match folder '${folder}'`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(folder) || folder.length > 64) {
    problems.push(`kiro: ${rel}: folder '${folder}' breaks the lowercase-hyphen <=64 rule`);
  }
  const desc = typeof fm.description === 'string' ? fm.description.trimEnd() : '';
  if (desc.length > 1024) {
    problems.push(`kiro: ${rel}: description is ${desc.length} chars — the kiro cap is 1024`);
  }
  return problems;
}

const SKILL_MD = /^skills\/[^/]+\/SKILL\.md$/;

function stampVersion(text: string, version: string): string {
  const fm = text.match(/^---\n[\s\S]*?\n---/);
  if (!fm) return text;
  const head = fm[0].slice(0, -4);
  return `${head}\nmetadata:\n  version: "${version}"\n---${text.slice(fm[0].length)}`;
}

function applyDialect(text: string, dialect: Dialect, names: string[]): string {
  if (dialect.kind === 'identity') return text;
  if (dialect.kind === 'codex') {
    const cfg: DialectConfig = {
      slashNames: [...names, ...dialect.slashAliases],
      replacements: dialect.replacements
    };
    return transformCodex(text, cfg);
  }
  const cfg: DialectConfig = { slashNames: [], replacements: dialect.replacements };
  return transformKiro(text, cfg);
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
  const problems: string[] = [];
  const payloads = new Map<string, Map<string, string | Buffer>>();

  let stampVer: string | null = null;
  if (manifest.versionSource) {
    try {
      const raw = JSON.parse(readFileSync(join(repoRoot, manifest.versionSource), 'utf8')) as {
        version?: unknown;
      };
      if (typeof raw.version === 'string') stampVer = raw.version;
      else problems.push(`versionSource ${manifest.versionSource}: no string "version" field`);
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

  for (const [name, flavor] of Object.entries(manifest.flavors)) {
    const payload = new Map<string, string | Buffer>();
    for (const rel of manifest.shared.rendered) {
      const source = readFileSync(join(sourceRoot, rel), 'utf8');
      let out = applyDialect(source, flavor.dialect, names);
      if (stampVer !== null && SKILL_MD.test(rel)) {
        out = stampVersion(out, stampVer);
      }
      let lintable = out;
      for (const allowed of manifest.lintAllow ?? []) {
        lintable = lintable.replaceAll(allowed, '');
      }
      if (flavor.dialect.kind !== 'identity' && lintable.includes('CLAUDE.md')) {
        problems.push(
          `${name}: ${rel}: \`CLAUDE.md\` survives the ${name} transform — extend the manifest replacements`
        );
      }
      if (flavor.dialect.kind === 'kiro') {
        problems.push(...assertKiroSkillCaps(rel, out));
      }
      payload.set(rel, out);
    }
    for (const entry of manifest.shared.exact) {
      if (entry.flavors && !entry.flavors.includes(name)) continue;
      payload.set(entry.path, readFileSync(join(sourceRoot, entry.path)));
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
