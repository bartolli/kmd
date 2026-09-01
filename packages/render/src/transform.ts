export interface DialectConfig {
  slashNames: string[];
  replacements: [string, string][];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rewriteSlashes(text: string, slashNames: string[], replacement: string): string {
  if (slashNames.length === 0) return text;
  const alts = [...slashNames]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return text.replace(new RegExp(`(?<![\\w/])/(${alts})(?![\\w-])`, 'g'), replacement);
}

function transformDialect(
  text: string,
  cfg: DialectConfig,
  slashReplacement: string | null,
  agent: string
): string {
  let out = text;
  for (const [from, to] of cfg.replacements) {
    out = out.replaceAll(from, to);
  }
  if (slashReplacement !== null) {
    out = rewriteSlashes(out, cfg.slashNames, slashReplacement);
  }
  return out.replace(/\bClaude\b(?! Code)/g, agent);
}

export function transformCodex(text: string, cfg: DialectConfig): string {
  return transformDialect(text, cfg, '$$$1', 'Codex');
}

// CoCo invokes skills as `$name`, same token as codex. Unlike codex it reads
// `CLAUDE.md` as a project-instructions file, so the CLAUDE.md-survival lint
// does not apply — see the reader set in render.ts.
export function transformCoco(text: string, cfg: DialectConfig): string {
  return transformDialect(text, cfg, '$$$1', 'CoCo');
}

// Kiro skills are slash-invocable — the invocation token survives; only the
// wording replacements and the bare-Claude rule apply.
export function transformKiro(text: string, cfg: DialectConfig): string {
  return transformDialect(text, cfg, null, 'Kiro');
}
