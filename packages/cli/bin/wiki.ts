#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  console.error('wiki failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
