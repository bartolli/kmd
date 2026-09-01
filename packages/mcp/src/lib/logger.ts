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

/**
 * stderr-only, synchronous: for the in-process CLI mirrors, which exit within
 * milliseconds of building the server. The async file sink above is not open
 * yet at that point and its exit-time flush throws; the file log belongs to
 * the long-running server.
 */
export function createStderrLogger(level: string, name: string): pino.Logger {
  return pino({ name, level, base: { pid: process.pid } }, pino.destination({ fd: 2, sync: true }));
}

export type Logger = pino.Logger;
