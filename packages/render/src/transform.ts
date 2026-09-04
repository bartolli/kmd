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
  // A slash after the name means a folder segment (`{scope}/intent/`), not an invocation.
  return text.replace(new RegExp(`(?<![\\w/])/(${alts})(?![\\w/-])`, 'g'), replacement);
}

// The source is harness-neutral (the render lint enforces it), so a dialect
// is the wording replacements plus the harness's invocation token.
function transformDialect(text: string, cfg: DialectConfig, slashReplacement: string): string {
  let out = text;
  for (const [from, to] of cfg.replacements) {
    out = out.replaceAll(from, to);
  }
  return rewriteSlashes(out, cfg.slashNames, slashReplacement);
}

export function transformCodex(text: string, cfg: DialectConfig): string {
  return transformDialect(text, cfg, '$$$1');
}

// CoCo invokes skills as `$name`, same token as codex. Unlike codex it reads
// `CLAUDE.md` as a project-instructions file, so the CLAUDE.md-survival lint
// does not apply — see the reader set in render.ts.
export function transformCoco(text: string, cfg: DialectConfig): string {
  return transformDialect(text, cfg, '$$$1');
}
