import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIAG_DIR = join(homedir(), '.local', 'state', 'wiki-mcp');
export const DIAG_LOG_PATH = join(DIAG_DIR, 'server.log');

try {
  mkdirSync(DIAG_DIR, { recursive: true });
} catch {
  // best-effort; do not block startup on log dir creation
}

/**
 * Synchronous file logger that survives even when pino, the MCP SDK, or any
 * import down the chain fails to load. Writes to ~/.local/state/wiki-mcp/server.log
 * regardless of stdio/stderr capture by the parent process. Use to trace
 * spawn-time failures that never reach pino.
 */
export function diag(msg: string, data?: Record<string, unknown>): void {
  try {
    const line = data
      ? `${new Date().toISOString()} pid=${process.pid} ${msg} ${JSON.stringify(data)}\n`
      : `${new Date().toISOString()} pid=${process.pid} ${msg}\n`;
    appendFileSync(DIAG_LOG_PATH, line);
  } catch {
    // best-effort; never crash the server on log write failure
  }
}
