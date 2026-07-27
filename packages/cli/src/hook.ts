import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { kmdHome } from '@llm-wiki/db/database';
import type { Trigger, VaultConfig } from './config.js';
import { loadVaultConfig } from './config.js';

export interface PromptEvent {
  session_id: string;
  prompt: string;
}

export interface InjectMatch {
  id: string;
  text: string;
}

/**
 * Built-in triggers ship with the engine; `vault.yaml` `triggers` replaces
 * them per scope, `triggers_extra` appends. Empty until field data nominates
 * universal defaults.
 */
const DEFAULT_TRIGGERS: Trigger[] = [];

const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function parsePromptEvent(raw: string): PromptEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { session_id, prompt } = data as Record<string, unknown>;
  if (typeof session_id !== 'string' || typeof prompt !== 'string') return null;
  return { session_id, prompt };
}

export function effectiveTriggers(config: VaultConfig, scope: string | undefined): Trigger[] {
  if (scope === undefined) return DEFAULT_TRIGGERS;
  const base = config.triggers?.[scope] ?? DEFAULT_TRIGGERS;
  return [...base, ...(config.triggers_extra?.[scope] ?? [])];
}

type InjectTrigger = Trigger & { text: string };

function keywordQuery(keywords: string[]): string {
  return keywords.map((keyword) => `"${keyword.replaceAll('"', '""')}"`).join(' OR ');
}

function openPromptIndex(prompt: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE prompt_doc USING fts5(text, tokenize = 'porter unicode61')`);
  db.prepare('INSERT INTO prompt_doc (text) VALUES (?)').run(prompt);
  return db;
}

/**
 * Inject-class prompt triggers only (slice 1). Keywords match word-boundary
 * and porter-stemmed against an in-memory FTS5 table — the prompt is the
 * document, the author-controlled keywords are the query, so raw user text
 * never enters FTS5 query syntax. `intent` regexes run case-insensitive over
 * the raw prompt.
 */
export function matchPromptTriggers(prompt: string, triggers: Trigger[]): InjectMatch[] {
  const candidates = triggers.filter(
    (trigger): trigger is InjectTrigger =>
      trigger.on === 'prompt' && trigger.enforce === 'inject' && trigger.text !== undefined
  );
  if (candidates.length === 0) return [];

  const matches: InjectMatch[] = [];
  let db: DatabaseSync | null = null;
  try {
    for (const trigger of candidates) {
      let hit = false;
      if (trigger.keywords !== undefined && trigger.keywords.length > 0) {
        db ??= openPromptIndex(prompt);
        const row = db
          .prepare('SELECT count(*) AS n FROM prompt_doc WHERE prompt_doc MATCH ?')
          .get(keywordQuery(trigger.keywords)) as { n: number };
        hit = row.n > 0;
      }
      if (!hit && trigger.intent !== undefined) {
        hit = trigger.intent.some((pattern) => new RegExp(pattern, 'i').test(prompt));
      }
      if (hit) {
        matches.push({ id: trigger.id, text: trigger.text });
      }
    }
  } finally {
    db?.close();
  }
  return matches;
}

/** Session dedup state — deliberately outside `db/` so `kmd db reset` keeps it. */
export function hookStateDir(): string {
  return join(kmdHome(), 'state', 'hook');
}

/**
 * Drops matches whose trigger id already fired for this session, records the
 * survivors. Stale session files are pruned opportunistically on write.
 */
export function dedupeMatches(
  stateDir: string,
  sessionId: string,
  matches: InjectMatch[]
): InjectMatch[] {
  if (matches.length === 0) return [];
  const file = join(stateDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const fired = readFired(file);
  const fresh = matches.filter((match) => !fired.has(match.id));
  if (fresh.length > 0) {
    mkdirSync(stateDir, { recursive: true });
    for (const match of fresh) {
      fired.add(match.id);
    }
    writeFileSync(file, JSON.stringify([...fired]));
    pruneStale(stateDir, file);
  }
  return fresh;
}

function readFired(file: string): Set<string> {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      return new Set(data.filter((entry): entry is string => typeof entry === 'string'));
    }
  } catch {
    // missing or corrupt state reads as "nothing fired" — worst case one repeated line
  }
  return new Set();
}

function pruneStale(stateDir: string, keep: string): void {
  try {
    const cutoff = Date.now() - SESSION_STATE_MAX_AGE_MS;
    for (const entry of readdirSync(stateDir)) {
      const path = join(stateDir, entry);
      if (path !== keep && statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
      }
    }
  } catch {
    // pruning is best-effort
  }
}

/**
 * `kmd hook prompt [<vault-root>] [--scope <s>]`. Exits 0 on every path and
 * never throws: stdout is the harness's context-injection channel, so a
 * degraded gate engine emits one stderr diagnostic and injects nothing —
 * it must never block a prompt.
 */
export async function runHookPrompt(): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: false,
      options: { scope: { type: 'string' } }
    });
    const vaultRoot = positionals[2] ?? process.env.WIKI_VAULT;
    if (vaultRoot === undefined || vaultRoot === '') {
      diag('no vault root (positional or $WIKI_VAULT)');
      return;
    }
    const scope = typeof values.scope === 'string' ? values.scope : process.env.WIKI_SCOPE;
    const event = parsePromptEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a prompt event ({session_id, prompt})');
      return;
    }
    const config = await loadVaultConfig(vaultRoot);
    const matches = matchPromptTriggers(event.prompt, effectiveTriggers(config, scope));
    for (const match of dedupeMatches(hookStateDir(), event.session_id, matches)) {
      console.log(match.text);
    }
  } catch (err) {
    diag(err instanceof Error ? err.message : String(err));
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function diag(message: string): void {
  console.error(`kmd hook: ${message}`);
}
