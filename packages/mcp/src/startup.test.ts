import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN_ENTRY = fileURLToPath(new URL('../bin/stdio.ts', import.meta.url));

function runStartup(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // stdin = /dev/null so the stdio transport sees EOF and can't block the test.
    const child = spawn('node', ['--import', 'tsx', BIN_ENTRY], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('wiki-mcp startup', () => {
  it('fails loud when vault.yaml is absent, before any DB access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-mcp-startup-'));
    const env = {
      ...process.env,
      WIKI_VAULT: dir,
      LOG_LEVEL: 'silent'
    };
    try {
      const { code, stderr } = await runStartup(env);

      expect(code).not.toBe(0);
      expect(stderr).toContain('vault.yaml not found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
