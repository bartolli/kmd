#!/usr/bin/env node
import { diag } from '../src/lib/diag.js';

diag('process started', {
  cwd: process.cwd(),
  argv: process.argv,
  node: process.version,
  WIKI_VAULT: process.env.WIKI_VAULT ?? '(unset)',
  LOG_LEVEL: process.env.LOG_LEVEL ?? '(unset)',
  PATH: process.env.PATH ?? '(unset)'
});

import { startMcpServer } from '../src/start.js';

diag('imports complete');

startMcpServer().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  diag('FATAL', { err: msg });
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
