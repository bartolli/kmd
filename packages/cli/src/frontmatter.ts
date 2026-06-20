import { parse as parseYaml } from 'yaml';

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
 * (deterministically, no cache) when the frontmatter is not valid YAML — this is
 * the failure mode `wiki validate` exists to catch. A page with no leading
 * delimiter parses to empty data and the whole input as body.
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
