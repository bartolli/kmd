#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const vault = process.env.WIKI_VAULT || join(homedir(), 'llm-wiki', 'vault');
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(command, ['-y', '@bartolli/kmd@latest', 'mcp', vault], {
  stdio: 'inherit',
  env: {
    ...process.env,
    WIKI_VAULT: vault,
    LOG_LEVEL: process.env.WIKI_MCP_LOG_LEVEL || process.env.LOG_LEVEL || 'info'
  }
});

child.on('error', (error) => {
  process.stderr.write(`Failed to start wiki MCP server: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
