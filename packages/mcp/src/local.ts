import { loadVaultConfig } from '@llm-wiki/db/vault-config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { VaultBinding } from './binding.js';
import { loadServerEnv } from './config.js';
import { createDatabase } from './db.js';
import { createStderrLogger } from './lib/logger.js';
import { buildServer } from './server.js';

/**
 * In-process client of the server `kmd mcp` serves over stdio: the same
 * McpServer, an SDK Client, and an in-memory transport between them. The CLI
 * mirrors (`kmd resource|prime|search`) go through the protocol — the handlers,
 * validation, and error shapes the agent reaches — with no second process and
 * no pipes. The binding is resolved before the server exists, so the deferred
 * roots path never engages.
 */
export interface LocalClient {
  readResource(uri: string): Promise<string>;
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ readonly text: string; readonly isError: boolean }>;
  close(): Promise<void>;
}

export async function openLocalClient(
  vaultRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalClient> {
  const serverEnv = loadServerEnv(env);
  const vaultConfig = await loadVaultConfig(vaultRoot);
  const db = createDatabase(vaultRoot);
  const binding: VaultBinding = { vaultRoot, db, vaultConfig };
  const mcp = buildServer({
    name: serverEnv.serverName,
    version: serverEnv.serverVersion,
    logger: createStderrLogger(serverEnv.logLevel, serverEnv.serverName),
    binding
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kmd-cli', version: serverEnv.serverVersion });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async readResource(uri) {
      const result = await client.readResource({ uri });
      return result.contents.map((c) => ('text' in c ? String(c.text) : '')).join('\n');
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as ReadonlyArray<{ type: string; text?: string }>;
      return {
        text: content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n'),
        isError: result.isError === true
      };
    },
    async close() {
      await client.close();
      await mcp.close();
      db.close();
    }
  };
}

/** What a CLI mirror prints and exits with — kept transport-free for tests. */
export interface Outcome {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const KNOWN_URIS =
  'known: wiki://authoring, wiki://templates, wiki://template/{domain}/{kind} (see wiki://templates)';

// The protocol's InvalidParams is the usage class (unknown URI, input that
// fails the tool schema); any other protocol error is an operation failure.
function fromMcpError(command: string, error: McpError, hint?: string): Outcome {
  const usage = error.code === ErrorCode.InvalidParams;
  // the SDK prefixes its own message once per hop; the code is in the exit status
  const message = error.message.replace(/^(MCP error -?\d+: )+/, '');
  const lines = [`kmd ${command}: ${message}`];
  if (usage && hint) lines.push(`  ${hint}`);
  return { code: usage ? 2 : 1, stdout: '', stderr: lines.join('\n') };
}

async function withClient(
  command: string,
  vaultRoot: string,
  env: NodeJS.ProcessEnv,
  hint: string | undefined,
  run: (client: LocalClient) => Promise<Outcome>
): Promise<Outcome> {
  const client = await openLocalClient(vaultRoot, env);
  try {
    return await run(client);
  } catch (error) {
    if (error instanceof McpError) return fromMcpError(command, error, hint);
    throw error;
  } finally {
    await client.close();
  }
}

export function runResource(
  uri: string,
  vaultRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Outcome> {
  return withClient('resource', vaultRoot, env, KNOWN_URIS, async (client) => ({
    code: 0,
    stdout: await client.readResource(uri),
    stderr: ''
  }));
}

export function runTool(
  name: 'prime' | 'search',
  args: Record<string, unknown>,
  vaultRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Outcome> {
  return withClient(name, vaultRoot, env, undefined, async (client) => {
    const { text, isError } = await client.callTool(name, args);
    if (!isError) return { code: 0, stdout: text, stderr: '' };
    // textError payloads are {code, message, details}; anything else prints as-is
    let message = text;
    try {
      const payload = JSON.parse(text) as { code?: string; message?: string };
      if (payload.code && payload.message) message = `${payload.code}: ${payload.message}`;
    } catch {
      // not JSON — keep the raw text
    }
    return { code: 1, stdout: '', stderr: `kmd ${name}: ${message}` };
  });
}
