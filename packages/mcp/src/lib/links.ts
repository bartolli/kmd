import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface StoredLink {
  source_path: string;
  target_path: string;
}

export interface LinkEdge {
  source: string;
  target: string;
}

/**
 * Every `.md` page under the vault root, title-less pages included: the
 * universe a slug resolves against, matching validate's. Dot entries
 * (`.git`, `.obsidian`) are skipped. A directory that vanished mid-walk is
 * absent; any other read error throws, since a partial owner list would let a
 * slug look unique.
 */
export async function vaultPagePaths(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(rel: string): Promise<void> {
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    });
    if (!entries) return;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await recurse(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
    }
  }
  await recurse('');
  return out;
}

/** `projects/{scope}` or `research/{topic}`; null for pages outside both. */
function locationKey(path: string): string | null {
  const [domain, name] = path.split('/');
  return (domain === 'projects' || domain === 'research') && name ? `${domain}/${name}` : null;
}

function slugOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/**
 * Stored links carry targets as written. A path-qualified target stands; a bare
 * slug resolves to a unique owner in the source's scope, else a unique owner
 * anywhere, else stays unresolved. Resolving at read time keeps it current
 * when another page's arrival or removal changes what a slug means.
 */
export function resolveLinks(
  links: readonly StoredLink[],
  candidates: readonly string[]
): LinkEdge[] {
  const owners = new Map<string, string[]>();
  for (const path of candidates) {
    const slug = slugOf(path);
    const list = owners.get(slug);
    if (list) list.push(path);
    else owners.set(slug, [path]);
  }

  const edges = new Map<string, LinkEdge>();
  for (const { source_path, target_path } of links) {
    const target = resolveTarget(source_path, target_path, owners);
    if (target !== null) edges.set(`${source_path}\0${target}`, { source: source_path, target });
  }
  return [...edges.values()];
}

function resolveTarget(
  source: string,
  target: string,
  owners: ReadonlyMap<string, string[]>
): string | null {
  if (target.includes('/')) return target;
  if (!target.endsWith('.md')) return null;
  const all = owners.get(slugOf(target)) ?? [];
  const here = locationKey(source);
  const local = here === null ? [] : all.filter((path) => locationKey(path) === here);
  if (local.length > 0) return local.length === 1 ? (local[0] as string) : null;
  return all.length === 1 ? (all[0] as string) : null;
}
