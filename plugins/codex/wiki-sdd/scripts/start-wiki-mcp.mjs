#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// --default-root keeps the engine's resolution chain live: a KMD_PROJECT_DIR
// passed through the plugin's env_vars whitelist binds the project tier ahead
// of the configured vault. Codex spawns this script in the plugin cache dir
// and offers no workspace signal of its own (verified against codex 0.146.0),
// so the chain engages only on an explicit export.
const vault = process.env.WIKI_VAULT || join(homedir(), 'llm-wiki', 'vault');
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(command, ['-y', '@bartolli/kmd@latest', 'mcp', '--default-root', vault], {
  stdio: 'inherit',
  env: {
    ...process.env,
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
