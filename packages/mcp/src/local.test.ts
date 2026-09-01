import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalClient, runResource, runTool } from './local.js';

// The CLI mirrors are clients of the server, not re-implementations: every
// assertion here is about what comes back through the protocol.

const VAULT_YAML = `scopes:
  demo:
    status: active
kinds: [project, spec, note]
statuses: [draft, active]
methodologies: [sdd]
tags:
  canonical: [mcp]
  aliases: {}
`;

const NOTE_TEMPLATE = '---\ntitle: {{title}}\nkind: note\n---\n\n# {{title}}\n';

let vault: string;
let kmdHome: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'kmd-local-client-'));
  vault = join(base, 'vault');
  kmdHome = join(base, 'kmd-home');
  await mkdir(join(vault, 'templates'), { recursive: true });
  await writeFile(join(vault, 'vault.yaml'), VAULT_YAML);
  await writeFile(join(vault, 'templates', 'note.md'), NOTE_TEMPLATE);
  // the index homes under KMD_HOME; the file log sink is the server's own
  env = { ...process.env, KMD_HOME: kmdHome, LOG_LEVEL: 'silent' };
});

afterEach(async () => {
  await rm(join(vault, '..'), { recursive: true, force: true });
});

describe('openLocalClient', () => {
  it('serves the authoring guide built from the bound vault config', async () => {
    const client = await openLocalClient(vault, env);
    try {
      const text = await client.readResource('wiki://authoring');
      expect(text).toContain('# Wiki authoring guide');
      expect(text).toContain('**Kinds:** project, spec, note');
    } finally {
      await client.close();
    }
  });

  it('serves a template file byte-for-byte and the template index', async () => {
    const client = await openLocalClient(vault, env);
    try {
      expect(await client.readResource('wiki://template/note')).toBe(NOTE_TEMPLATE);
      expect(await client.readResource('wiki://templates')).toContain('wiki://template/note');
    } finally {
      await client.close();
    }
  });

  it('surfaces an unknown URI as the protocol error, not a crash', async () => {
    const client = await openLocalClient(vault, env);
    try {
      await expect(client.readResource('wiki://nope')).rejects.toBeInstanceOf(McpError);
    } finally {
      await client.close();
    }
  });

  it('calls the tools through the protocol, error shape included', async () => {
    const client = await openLocalClient(vault, env);
    try {
      const search = await client.callTool('search', { query: 'anything' });
      expect(search.isError).toBe(false);
      expect(() => JSON.parse(search.text)).not.toThrow();
      const prime = await client.callTool('prime', { scope: 'nope' });
      expect(prime.isError).toBe(true);
      expect(prime.text).toContain('UNKNOWN_SCOPE');
    } finally {
      await client.close();
    }
  });
});

describe('CLI mirror outcomes', () => {
  it('resource: guide on stdout, exit 0', async () => {
    const outcome = await runResource('wiki://authoring', vault, env);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('# Wiki authoring guide');
    expect(outcome.stderr).toBe('');
  });

  it('resource: unknown URI is usage, exit 2, known URIs named', async () => {
    const outcome = await runResource('wiki://nope', vault, env);
    expect(outcome.code).toBe(2);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toContain('wiki://nope');
    expect(outcome.stderr).toContain('wiki://authoring');
  });

  it('resource: a missing template file is an operation failure, exit 1', async () => {
    const outcome = await runResource('wiki://template/project/spec', vault, env);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('template file missing');
  });

  it('prime: unlisted scope is the tool error, exit 1', async () => {
    const outcome = await runTool('prime', { scope: 'nope' }, vault, env);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/^kmd prime: UNKNOWN_SCOPE: /);
  });

  it('prime: a schema violation comes back as a tool error, exit 1', async () => {
    const outcome = await runTool('prime', { scope: '' }, vault, env);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/^kmd prime: /);
  });

  it('search: candidates JSON on stdout, exit 0', async () => {
    const outcome = await runTool('search', { query: 'anything', limit: 3 }, vault, env);
    expect(outcome.code).toBe(0);
    expect(() => JSON.parse(outcome.stdout)).not.toThrow();
  });
});
