import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const KMD_ENTRY = fileURLToPath(new URL('./kmd.ts', import.meta.url));
const TSX_ENTRY = createRequire(import.meta.url).resolve('tsx');

const VAULT_YAML = `scopes:
  demo:
    status: active
    repo: /kmd-mcp-roots-demo-repo
kinds: [spec]
statuses: [active]
methodologies: [sdd]
tags:
  canonical: []
  aliases: {}
`;

function childEnv(kmdHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.WIKI_VAULT;
  delete env.WIKI_SCOPE;
  delete env.KMD_PROJECT_DIR;
  env.KMD_HOME = kmdHome;
  env.LOG_LEVEL = 'silent';
  return env;
}

interface Session {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stderr: () => string;
}

/** Spawn `kmd mcp <args>` and connect an SDK client that serves `roots/list`. */
async function connectClient(input: {
  args: string[];
  kmdHome: string;
  cwd: string;
  roots: string[] | null;
}): Promise<Session> {
  const client = new Client(
    { name: 'kmd-roots-e2e', version: '0.0.0' },
    { capabilities: input.roots === null ? {} : { roots: { listChanged: true } } }
  );
  if (input.roots !== null) {
    const roots = input.roots.map((dir) => ({ uri: pathToFileURL(dir).href }));
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
  }
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', TSX_ENTRY, KMD_ENTRY, 'mcp', ...input.args],
    env: childEnv(input.kmdHome),
    cwd: input.cwd,
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

async function primeVaultRoot(client: Client): Promise<string> {
  const result = (await client.callTool({ name: 'prime', arguments: { scope: 'demo' } })) as {
    structuredContent?: Record<string, unknown>;
  };
  return String(result.structuredContent?.vault_root);
}

describe('kmd mcp roots-sourced deferred binding (end-to-end)', () => {
  let base: string;
  let kmdHome: string;
  let neutral: string;
  let session: Session | null;

  beforeEach(async () => {
    // realpath: resolution canonicalizes, and macOS tmpdir is a symlink
    base = realpathSync(await mkdtemp(join(tmpdir(), 'kmd-mcp-roots-')));
    kmdHome = join(base, 'kmd-home');
    neutral = join(base, 'neutral');
    await mkdir(neutral, { recursive: true });
    session = null;
  });

  afterEach(async () => {
    await session?.client.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });

  async function makeProject(name: string): Promise<{ project: string; vault: string }> {
    const project = join(base, name);
    const vault = join(project, 'vault');
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, 'vault.yaml'), VAULT_YAML);
    return { project, vault };
  }

  it('binds the first client root that maps to a vault, with env absent', async () => {
    const bare = join(base, 'no-tier');
    await mkdir(bare, { recursive: true });
    const { project, vault } = await makeProject('proj');

    session = await connectClient({
      args: [],
      kmdHome,
      cwd: neutral,
      roots: [bare, project]
    });

    expect(await primeVaultRoot(session.client)).toBe(vault);
  }, 60_000);

  it('falls through to --default-root when no client root maps', async () => {
    const bare = join(base, 'no-tier');
    await mkdir(bare, { recursive: true });
    const fallback = join(base, 'fallback-vault');
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, 'vault.yaml'), VAULT_YAML);

    session = await connectClient({
      args: ['--default-root', fallback],
      kmdHome,
      cwd: neutral,
      roots: [bare]
    });

    expect(await primeVaultRoot(session.client)).toBe(fallback);
  }, 60_000);

  it("the power's server binds the machine default: no roots, a scrubbed env, cwd at the install dir under HOME", async () => {
    const home = join(base, 'home');
    const homeKmd = join(home, '.kmd');
    const powerDir = join(home, '.kiro', 'powers', 'installed', 'wiki-sdd');
    await mkdir(powerDir, { recursive: true });
    const vault = join(base, 'machine-default');
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, 'vault.yaml'), VAULT_YAML);
    await mkdir(homeKmd, { recursive: true });
    await writeFile(join(homeKmd, 'config.yaml'), `default_vault: ${vault}\n`);

    session = await connectClient({ args: [], kmdHome: homeKmd, cwd: powerDir, roots: null });

    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['prime', 'search']);
    expect(await primeVaultRoot(session.client)).toBe(vault);
  }, 60_000);

  it('a client without the roots capability binds through the cwd-fed chain', async () => {
    const { project, vault } = await makeProject('cwd-proj');

    session = await connectClient({
      args: [],
      kmdHome,
      cwd: project,
      roots: null
    });

    expect(await primeVaultRoot(session.client)).toBe(vault);
  }, 60_000);

  it('fails loud at bind time when nothing resolves', async () => {
    const bare = join(base, 'no-tier');
    await mkdir(bare, { recursive: true });

    session = await connectClient({
      args: [],
      kmdHome,
      cwd: neutral,
      roots: [bare]
    });

    await expect(
      session.client.callTool({ name: 'prime', arguments: { scope: 'demo' } })
    ).rejects.toThrow();

    await expect
      .poll(() => session?.stderr() ?? '', { timeout: 10_000 })
      .toContain('no vault resolvable');
  }, 60_000);
});
