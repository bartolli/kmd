import pino from 'pino';
import { DIAG_LOG_PATH } from './diag.js';

/**
 * Pino logger that fans out to BOTH stderr (fd 2, captured by Claude Code)
 * AND ~/.local/state/wiki-mcp/server.log (so logs survive when stderr capture
 * doesn't make it into the JSONL connection log). The file destination shares
 * the path with diag.ts so a single `tail -f` follows the entire startup +
 * runtime stream.
 */
export function createLogger(level: string, name: string): pino.Logger {
  const streams: pino.StreamEntry[] = [
    { level: level as pino.Level, stream: pino.destination(2) },
    {
      level: level as pino.Level,
      stream: pino.destination({ dest: DIAG_LOG_PATH, sync: false, mkdir: true })
    }
  ];
  return pino({ name, level, base: { pid: process.pid } }, pino.multistream(streams));
}

export type Logger = pino.Logger;
