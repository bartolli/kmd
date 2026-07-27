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

function eventFields(raw: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  return data as Record<string, unknown>;
}

export function parsePromptEvent(raw: string): PromptEvent | null {
  const fields = eventFields(raw);
  if (fields === null) return null;
  const { session_id, prompt } = fields;
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

export interface PretoolEvent {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
}

export interface PretoolMatch {
  id: string;
  enforce: 'inject' | 'warn' | 'block';
  text: string;
}

export function parsePretoolEvent(raw: string): PretoolEvent | null {
  const fields = eventFields(raw);
  if (fields === null) return null;
  const { session_id, tool_name, tool_input, cwd } = fields;
  if (typeof session_id !== 'string' || typeof tool_name !== 'string') return null;
  return { session_id, tool_name, tool_input, ...(typeof cwd === 'string' && { cwd }) };
}

/**
 * Pinned glob semantics for the deny path: `**` crosses directories (`**​/`
 * optionally empty), `*` stays within a segment, `?` is one character.
 * Hand-rolled instead of `path.matchesGlob`, whose semantics are still
 * experimental and may drift across the Node versions users run.
 */
function globToRegExp(glob: string): RegExp {
  let source = '^';
  let i = 0;
  while (i < glob.length) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob.startsWith('**/', i)) {
        source += '(?:.*/)?';
        i += 3;
      } else if (glob.startsWith('**', i)) {
        source += '.*';
        i += 2;
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${source}$`);
}

function pathCandidates(toolInput: unknown, cwd: string | undefined): string[] {
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  const fields = toolInput as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = fields[key];
    if (typeof value === 'string' && value !== '') {
      candidates.push(value);
      if (cwd !== undefined && value.startsWith(`${cwd}/`)) {
        candidates.push(value.slice(cwd.length + 1));
      }
    }
  }
  return candidates;
}

export function matchPretoolTriggers(
  toolName: string,
  toolInput: unknown,
  triggers: Trigger[],
  cwd?: string
): { matches: PretoolMatch[]; skipped: string[] } {
  const matches: PretoolMatch[] = [];
  const skipped: string[] = [];
  for (const trigger of triggers) {
    if (trigger.on !== 'pretool') continue;
    if (trigger.when !== undefined) {
      // State predicates land in slice 3; skipping silently would fake a gate.
      skipped.push(trigger.id);
      continue;
    }
    if (trigger.tool !== undefined && trigger.tool !== toolName) continue;
    if (trigger.args_match !== undefined) {
      const serialized = JSON.stringify(toolInput ?? {});
      if (!new RegExp(trigger.args_match).test(serialized)) continue;
    }
    if (trigger.files !== undefined && trigger.files.length > 0) {
      const candidates = pathCandidates(toolInput, cwd);
      const hit = trigger.files.some((glob) => {
        const regex = globToRegExp(glob);
        return candidates.some((candidate) => regex.test(candidate));
      });
      if (!hit) continue;
    }
    const text = trigger.enforce === 'block' ? trigger.reason : trigger.text;
    if (text === undefined) continue;
    matches.push({ id: trigger.id, enforce: trigger.enforce, text });
  }
  return { matches, skipped };
}

export function renderPretool(
  matches: PretoolMatch[],
  format: 'neutral' | 'claude'
): { stdout: string | null; stderr: string[] } {
  const block = matches.find((match) => match.enforce === 'block');
  const context = matches.filter((match) => match.enforce === 'inject').map((match) => match.text);
  const warnings = matches.filter((match) => match.enforce === 'warn').map((match) => match.text);
  if (format === 'claude') {
    // "allow" would auto-approve the tool call; inject/warn must leave the
    // permission flow untouched, so the decision appears only on deny.
    const hookSpecificOutput: Record<string, string> = { hookEventName: 'PreToolUse' };
    if (block !== undefined) {
      hookSpecificOutput.permissionDecision = 'deny';
      hookSpecificOutput.permissionDecisionReason = block.text;
    }
    if (context.length > 0) {
      hookSpecificOutput.additionalContext = context.join('\n');
    }
    const decided = block !== undefined || context.length > 0;
    return { stdout: decided ? JSON.stringify({ hookSpecificOutput }) : null, stderr: warnings };
  }
  if (matches.length === 0) return { stdout: null, stderr: [] };
  return {
    stdout: JSON.stringify({
      decision: block !== undefined ? 'deny' : 'none',
      ...(block !== undefined && { reason: block.text }),
      context,
      warnings
    }),
    stderr: []
  };
}

/** Block-class gates fire on every event; only inject/warn spend the noise budget. */
export function dedupePretoolMatches(
  stateDir: string,
  sessionId: string,
  matches: PretoolMatch[]
): PretoolMatch[] {
  const blocks = matches.filter((match) => match.enforce === 'block');
  const rest = matches.filter((match) => match.enforce !== 'block');
  const fresh = dedupeMatches(stateDir, sessionId, rest);
  return matches.filter((match) => blocks.includes(match) || fresh.includes(match));
}

/** Session dedup state — deliberately outside `db/` so `kmd db reset` keeps it. */
export function hookStateDir(): string {
  return join(kmdHome(), 'state', 'hook');
}

/**
 * Drops matches whose trigger id already fired for this session, records the
 * survivors. Stale session files are pruned opportunistically on write.
 */
export function dedupeMatches<T extends { id: string }>(
  stateDir: string,
  sessionId: string,
  matches: T[]
): T[] {
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
interface HookInvocation {
  vaultRoot: string;
  scope: string | undefined;
  harness: unknown;
}

function hookInvocation(): HookInvocation | null {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: { scope: { type: 'string' }, harness: { type: 'string' } }
  });
  const vaultRoot = positionals[2] ?? process.env.WIKI_VAULT;
  if (vaultRoot === undefined || vaultRoot === '') {
    diag('no vault root (positional or $WIKI_VAULT)');
    return null;
  }
  return {
    vaultRoot,
    scope: typeof values.scope === 'string' ? values.scope : process.env.WIKI_SCOPE,
    harness: values.harness
  };
}

export async function runHookPrompt(): Promise<void> {
  try {
    const invocation = hookInvocation();
    if (invocation === null) return;
    const { vaultRoot, scope } = invocation;
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

/**
 * `kmd hook pretool [<vault-root>] [--scope <s>] [--harness claude]`. Fails
 * open: a degraded engine (missing/invalid config, bad payload) emits one
 * stderr diagnostic per event and no decision — loud enough to get fixed,
 * never denying unrelated work on a config typo. Exits 0 on every path.
 */
export async function runHookPretool(): Promise<void> {
  try {
    const invocation = hookInvocation();
    if (invocation === null) return;
    const { vaultRoot, scope } = invocation;
    let format: 'neutral' | 'claude' = 'neutral';
    if (invocation.harness === 'claude') {
      format = 'claude';
    } else if (invocation.harness !== undefined) {
      diag(`unknown harness "${String(invocation.harness)}" — emitting the neutral contract`);
    }
    const event = parsePretoolEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a pretool event ({session_id, tool_name})');
      return;
    }
    const config = await loadVaultConfig(vaultRoot);
    const { matches, skipped } = matchPretoolTriggers(
      event.tool_name,
      event.tool_input,
      effectiveTriggers(config, scope),
      event.cwd
    );
    for (const id of skipped) {
      diag(`trigger "${id}" has a when predicate — skipped until state predicates ship`);
    }
    const rendered = renderPretool(
      dedupePretoolMatches(hookStateDir(), event.session_id, matches),
      format
    );
    for (const line of rendered.stderr) {
      console.error(line);
    }
    if (rendered.stdout !== null) {
      console.log(rendered.stdout);
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
