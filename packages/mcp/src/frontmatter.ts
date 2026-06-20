import { parse as parseYaml } from 'yaml';

// Verbatim mirror of @llm-wiki/cli's src/frontmatter.ts. Kept byte-identical so
// mcp parses frontmatter the same way sync/validate do. Collapse into a shared
// package only when a third separate consumer appears (CLAUDE.md YAGNI rule).

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

// Leading `---` block, YAML, closing `---`, then one consumed newline. Matches
// gray-matter's delimiter handling; the closing `---` must be on its own line so
// `---` rules inside the body are left intact.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/;

/**
 * Split a page's frontmatter from its body using the `yaml` parser. Throws
 * (deterministically, no cache) when the frontmatter is not valid YAML. A page
 * with no leading delimiter parses to empty data and the whole input as body.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { data: {}, content: raw };
  }
  const yamlText = match[1] ?? '';
  const content = raw.slice(match[0].length);
  if (yamlText.trim() === '') {
    return { data: {}, content };
  }
  const parsed = parseYaml(yamlText);
  const data =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { data, content };
}
