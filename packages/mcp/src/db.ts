import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@llm-wiki/db/database';

export function createDatabase(): DatabaseSync {
  const dbDir = join(homedir(), '.kmd', 'db');
  const dbPath = join(dbDir, 'index.db');
  mkdirSync(dbDir, { recursive: true });
  return openDatabase(dbPath);
}
