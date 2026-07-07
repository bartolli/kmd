import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalVaultRoot, openDatabase, resolveIndexPath, setMeta } from '@llm-wiki/db/database';

/**
 * Open the per-vault index for this server's vault root, recording the root
 * in the index meta so `kmd config` can discover it from any shell — even for
 * a vault that has never been synced.
 */
export function createDatabase(vaultRoot: string): DatabaseSync {
  const dbPath = resolveIndexPath(vaultRoot);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  setMeta(db, 'vault_root', canonicalVaultRoot(vaultRoot));
  return db;
}
