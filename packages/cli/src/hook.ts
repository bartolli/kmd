import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { kmdHome } from '@llm-wiki/db/database';
import type { Trigger, VaultConfig } from '@llm-wiki/db/vault-config';
import { loadVaultConfig, TriggerSchema } from '@llm-wiki/db/vault-config';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';
import { syncVault } from './sync.js';
import { type Finding, hasErrors, validateVault } from './validate.js';

export interface PromptEvent {
  session_id: string;
  prompt: string;
  cwd?: string;
}

export interface InjectMatch {
  id: string;
  text: string;
  dedup?: Trigger['dedup'];
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
  const { session_id, prompt, cwd } = fields;
  if (typeof session_id !== 'string' || typeof prompt !== 'string') return null;
  return { session_id, prompt, ...(typeof cwd === 'string' && { cwd }) };
}

/** Dedup key granularity for the kiro-ide codec, which has no session id. */
const KIRO_IDE_BUCKET_MS = 30 * 60 * 1000;

/**
 * Kiro IDE (≤0.12.x) delivers the prompt via $USER_PROMPT and neither writes
 * nor closes stdin — reading it blocks until the hook timeout, so this codec
 * must never touch the pipe. Absent env means a newer build that delivers the
 * event on stdin instead; the caller falls back to the neutral codec. With no
 * session identifier available, the dedup key is a per-workspace 30-minute
 * time bucket: noise bounded, suppression never permanent. A bucket boundary
 * crossed mid-conversation re-fires triggers that already fired.
 */
export function kiroIdePromptEvent(now = Date.now()): PromptEvent | null {
  const prompt = process.env.USER_PROMPT;
  if (prompt === undefined || prompt === '') return null;
  const cwd = process.cwd();
  return { session_id: `kiro:${cwd}:${Math.floor(now / KIRO_IDE_BUCKET_MS)}`, prompt, cwd };
}

/**
 * Compiled skill-activation triggers shipped by a plugin (`--triggers`).
 * Returns null on any failure — the shell diags and degrades open, keeping
 * vault-owned triggers alive.
 */
export function loadTriggerFile(path: string): Trigger[] | null {
  try {
    const result = z.array(TriggerSchema).safeParse(parseYaml(readFileSync(path, 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Reserved `triggers_extra` key whose entries apply to every invocation. */
const ALL_SCOPES_KEY = '_all';

/**
 * DEFAULT_TRIGGERS ++ file triggers ++ `_all` extras ++ scope `triggers_extra`;
 * a scope's full-replace `triggers` takes total control of the base (defaults
 * and file source) while both extras sections still append. Duplicate ids keep
 * the first occurrence and report the rest.
 */
export function effectiveTriggers(
  config: VaultConfig,
  scope: string | undefined,
  fileTriggers: Trigger[] = []
): { triggers: Trigger[]; duplicates: string[] } {
  const replace = scope === undefined ? undefined : config.triggers?.[scope];
  const base = replace ?? [...DEFAULT_TRIGGERS, ...fileTriggers];
  const allExtras = config.triggers_extra?.[ALL_SCOPES_KEY] ?? [];
  const scopeExtras =
    scope === undefined || scope === ALL_SCOPES_KEY ? [] : (config.triggers_extra?.[scope] ?? []);
  const seen = new Set<string>();
  const triggers: Trigger[] = [];
  const duplicates: string[] = [];
  for (const trigger of [...base, ...allExtras, ...scopeExtras]) {
    if (seen.has(trigger.id)) {
      duplicates.push(trigger.id);
      continue;
    }
    seen.add(trigger.id);
    triggers.push(trigger);
  }
  return { triggers, duplicates };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Scope from the event's working directory: the scope whose `repo` contains
 * cwd, longest declared path winning. `~` expands to the home directory;
 * non-absolute repo values never match.
 */
export function resolveScope(config: VaultConfig, cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined;
  let best: string | undefined;
  let bestLength = -1;
  for (const [name, scope] of Object.entries(config.scopes)) {
    if (scope.repo === undefined) continue;
    const repo = expandHome(scope.repo).replace(/\/+$/, '');
    if (!repo.startsWith('/')) continue;
    if (cwd !== repo && !cwd.startsWith(`${repo}/`)) continue;
    if (repo.length > bestLength) {
      best = name;
      bestLength = repo.length;
    }
  }
  return best;
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
        matches.push({
          id: trigger.id,
          text: trigger.text,
          ...(trigger.dedup !== undefined && { dedup: trigger.dedup })
        });
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
  when?: Trigger['when'];
  dedup?: Trigger['dedup'];
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
): PretoolMatch[] {
  const matches: PretoolMatch[] = [];
  for (const trigger of triggers) {
    if (trigger.on !== 'pretool') continue;
    if (trigger.tool !== undefined && trigger.tool !== toolName) continue;
    if (trigger.args_match !== undefined) {
      const serialized = JSON.stringify(toolInput ?? {});
      if (!new RegExp(trigger.args_match).test(serialized)) continue;
    }
    if (trigger.files !== undefined && trigger.files.length > 0) {
      const candidates = [...pathCandidates(toolInput, cwd), ...patchPaths(toolInput)];
      const hit = trigger.files.some((glob) => {
        const regex = globToRegExp(glob);
        return candidates.some((candidate) => regex.test(candidate));
      });
      if (!hit) continue;
    }
    const text = trigger.enforce === 'block' ? trigger.reason : trigger.text;
    if (text === undefined) continue;
    matches.push({
      id: trigger.id,
      enforce: trigger.enforce,
      text,
      ...(trigger.when !== undefined && { when: trigger.when }),
      ...(trigger.dedup !== undefined && { dedup: trigger.dedup })
    });
  }
  return matches;
}

/**
 * Resolve `when` preconditions for matched triggers only — a predicate walk
 * never runs for a tool call no trigger matched. `when` names the condition
 * under which the action is ALLOWED: the trigger fires when it evaluates
 * false, is suppressed when true, and is skipped (reported) when the
 * predicate is unknown or unevaluable.
 */
export function evaluateMatches(
  matches: PretoolMatch[],
  vaultRoot: string
): { fired: PretoolMatch[]; skipped: string[] } {
  const fired: PretoolMatch[] = [];
  const skipped: string[] = [];
  for (const match of matches) {
    if (match.when === undefined) {
      fired.push(match);
      continue;
    }
    const verdict = evaluateWhen(match.when, vaultRoot);
    if (verdict === null) skipped.push(match.id);
    else if (!verdict) fired.push(match);
  }
  return { fired, skipped };
}

function evaluateWhen(when: NonNullable<Trigger['when']>, vaultRoot: string): boolean | null {
  if (typeof when === 'string') return null;
  try {
    const than = newestUpdated(vaultRoot, when.than);
    if (than === null) return true;
    const fresh = newestUpdated(vaultRoot, when.fresh);
    if (fresh === null) return false;
    return fresh >= than;
  } catch {
    return null;
  }
}

function newestUpdated(vaultRoot: string, globs: string[]): string | null {
  const regexes = globs.map(globToRegExp);
  let newest: string | null = null;
  for (const entry of readdirSync(vaultRoot, { recursive: true }) as string[]) {
    const rel = entry.split(sep).join('/');
    if (!rel.endsWith('.md')) continue;
    if (rel.startsWith('.') || rel.includes('/.')) continue;
    if (!regexes.some((regex) => regex.test(rel))) continue;
    const updated = readUpdated(join(vaultRoot, entry));
    if (updated !== null && (newest === null || updated > newest)) {
      newest = updated;
    }
  }
  return newest;
}

function readUpdated(path: string): string | null {
  try {
    const { data } = parseFrontmatter(readFileSync(path, 'utf8'));
    const updated = data.updated;
    if (typeof updated === 'string') return updated;
    if (updated instanceof Date) return updated.toISOString().slice(0, 10);
  } catch {
    // a malformed page is validate's problem, not the gate's
  }
  return null;
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

// Codex apply_patch envelope: paths live in the patch text, not input fields.
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function patchPaths(toolInput: unknown): string[] {
  const fields =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {};
  const sources = [toolInput, fields.patch, fields.input, fields.command].filter(
    (value): value is string => typeof value === 'string'
  );
  const paths: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(PATCH_FILE_RE)) {
      paths.push((match[1] as string).trim());
    }
  }
  return paths;
}

/**
 * Shell command strings carry mutation targets no path field names — `rm`,
 * `mv`, `sed -i`, redirections. Tokens are quote-aware; one counts as a path
 * candidate when it contains a separator or ends in a vault content
 * extension. Over-matching is safe (validate + sync is idempotent); the
 * silent miss is the failure mode this closes. Paths built dynamically or
 * resolved behind an in-command `cd` stay out of reach.
 */
const COMMAND_TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
const PATHISH_RE = /\/|\.(?:md|base|canvas|ya?ml)$/i;

function commandPaths(toolInput: unknown): string[] {
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return [];
  const paths: string[] = [];
  for (const match of command.matchAll(COMMAND_TOKEN_RE)) {
    const token = (match[1] ?? match[2] ?? match[3]) as string;
    for (const piece of token.split(/[;|&<>()]+/)) {
      if (piece !== '' && PATHISH_RE.test(piece)) paths.push(piece);
    }
  }
  return paths;
}

/**
 * Path guard for the posttool event: did this tool call touch a file inside
 * the vault? Relative candidates resolve against the event cwd. A miss is the
 * hot path — every non-vault edit in a session flows through here.
 */
export function vaultPathTouched(toolInput: unknown, vaultRoot: string, cwd?: string): boolean {
  const root = resolve(vaultRoot);
  const candidates = [
    ...pathCandidates(toolInput, cwd),
    ...patchPaths(toolInput),
    ...commandPaths(toolInput)
  ];
  return candidates.some((candidate) => {
    const absolute = resolve(cwd ?? '.', candidate);
    return absolute === root || absolute.startsWith(`${root}/`);
  });
}

/** Engine defaults for the fixed-function hook prose ([[adr-builtin-hook-identity]]). */
const RESYNC_REASON = 'Edit landed; the index sync is held until these validate errors are fixed';
const RESYNC_TEXT = 'kmd sync failed — index not updated; see hook stderr';
const HANDOFF_GATE_REASON =
  'Validate errors are outstanding and the index sync is held — fix them, let the resync run, then finish';

/**
 * Posttool outcome codec — public id `resync`. Errors read as the fix list
 * (sync did not run); warnings pass the sync gate but still surface once. The
 * quiet path — no findings, sync clean — renders nothing: zero per-edit
 * noise. `messages` overrides the preamble prose only; the error lines are
 * always engine-appended.
 */
export function renderPosttool(
  findings: Finding[],
  synced: boolean,
  format: 'neutral' | 'claude',
  messages: { reason?: string | undefined; text?: string | undefined } = {}
): string | null {
  if (findings.length === 0 && synced) return null;
  const lines = findings.map((f) => `${f.severity}: ${f.path} [${f.rule}] ${f.message}`);
  if (format === 'claude') {
    if (hasErrors(findings)) {
      return JSON.stringify({
        decision: 'block',
        reason: `${messages.reason ?? RESYNC_REASON}:\n${lines.join('\n')}`
      });
    }
    const hookSpecificOutput: Record<string, string> = { hookEventName: 'PostToolUse' };
    const notes = [...lines];
    if (!synced) notes.push(messages.text ?? RESYNC_TEXT);
    hookSpecificOutput.additionalContext = notes.join('\n');
    return JSON.stringify({ hookSpecificOutput });
  }
  return JSON.stringify({ findings, synced });
}

export interface StopEvent {
  session_id: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

export function parseStopEvent(raw: string): StopEvent | null {
  const fields = eventFields(raw);
  if (fields === null) return null;
  const { session_id, cwd, stop_hook_active } = fields;
  if (typeof session_id !== 'string') return null;
  return {
    session_id,
    ...(typeof cwd === 'string' && { cwd }),
    ...(typeof stop_hook_active === 'boolean' && { stop_hook_active })
  };
}

/**
 * Stop gate codec — public id `handoff-gate`. Claude, codex, and kiro-cli
 * all read the same `{decision: "block", reason}` stdout contract for Stop,
 * so there is no per-harness format. Warnings never block a handoff — only
 * the errors that hold the index sync. `reason` overrides the preamble; the
 * error lines are always engine-appended.
 */
export function renderStop(findings: Finding[], reason?: string): string | null {
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length === 0) return null;
  const lines = errors.map((f) => `${f.severity}: ${f.path} [${f.rule}] ${f.message}`);
  return JSON.stringify({
    decision: 'block',
    reason: `${reason ?? HANDOFF_GATE_REASON}:\n${lines.join('\n')}`
  });
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
 * Drops matches whose dedup key already fired for this session, records the
 * survivors. The per-trigger `dedup` policy selects the key: `session`
 * (default) keys on the trigger id, `{minutes: N}` appends the time bucket so
 * a new bucket re-fires within the session, `never` skips the state entirely.
 * State is one marker file per key inside a per-session directory; markers
 * are created atomically (`wx`), so concurrent events can add keys but never
 * erase each other's. Persistence is auxiliary state after the decision: a
 * failure repeats a reminder at worst and never changes the returned matches.
 * Stale sessions are pruned opportunistically on write.
 */
export function dedupeMatches<T extends { id: string; dedup?: Trigger['dedup'] }>(
  stateDir: string,
  sessionId: string,
  matches: T[],
  now = Date.now()
): T[] {
  if (matches.length === 0) return [];
  const dir = join(stateDir, safeName(sessionId));
  const fired = readFired(dir);
  const fresh: T[] = [];
  const record: string[] = [];
  for (const match of matches) {
    if (match.dedup === 'never') {
      fresh.push(match);
      continue;
    }
    const key = safeName(
      typeof match.dedup === 'object'
        ? `${match.id}@${Math.floor(now / (match.dedup.minutes * 60_000))}`
        : match.id
    );
    if (fired.has(key)) continue;
    fresh.push(match);
    record.push(key);
  }
  if (record.length > 0) {
    try {
      mkdirSync(dir, { recursive: true });
      for (const key of record) {
        try {
          writeFileSync(join(dir, key), '', { flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      pruneStale(stateDir, dir);
    } catch (err) {
      diag(`dedup state not persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return fresh;
}

function safeName(part: string): string {
  return part.replace(/[^A-Za-z0-9._@-]/g, '_');
}

function readFired(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    // no session state yet — nothing fired
    return new Set();
  }
}

function pruneStale(stateDir: string, keep: string): void {
  try {
    const cutoff = Date.now() - SESSION_STATE_MAX_AGE_MS;
    for (const entry of readdirSync(stateDir)) {
      const path = join(stateDir, entry);
      if (path !== keep && statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  } catch {
    // pruning is best-effort
  }
}

/**
 * `kmd hook prompt [<vault-root>] [--scope <s>] [--harness kiro-ide]`. Exits 0
 * on every path and never throws: stdout is the harness's context-injection
 * channel, so a degraded gate engine emits one stderr diagnostic and injects
 * nothing — it must never block a prompt. `--harness` selects the input codec;
 * without it (claude, codex, kiro-cli) the event arrives as JSON on stdin.
 */
interface HookInvocation {
  vaultRoot: string;
  scope: string | undefined;
  harness: unknown;
  triggersFile: unknown;
}

function hookInvocation(): HookInvocation | null {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      scope: { type: 'string' },
      harness: { type: 'string' },
      triggers: { type: 'string' }
    }
  });
  const vaultRoot = positionals[2] ?? process.env.WIKI_VAULT;
  if (vaultRoot === undefined || vaultRoot === '') {
    diag('no vault root (positional or $WIKI_VAULT)');
    return null;
  }
  return {
    vaultRoot,
    scope: typeof values.scope === 'string' ? values.scope : process.env.WIKI_SCOPE,
    harness: values.harness,
    triggersFile: values.triggers
  };
}

function resolveFileTriggers(invocation: HookInvocation): Trigger[] {
  if (typeof invocation.triggersFile !== 'string') return [];
  const loaded = loadTriggerFile(invocation.triggersFile);
  if (loaded === null) {
    diag(`triggers file unreadable or invalid: ${invocation.triggersFile}`);
    return [];
  }
  return loaded;
}

export async function runHookPrompt(): Promise<void> {
  try {
    const invocation = hookInvocation();
    if (invocation === null) return;
    const { vaultRoot } = invocation;
    let event: PromptEvent | null = null;
    if (invocation.harness === 'kiro-ide') {
      event = kiroIdePromptEvent();
    } else if (invocation.harness !== undefined) {
      diag(`unknown harness "${String(invocation.harness)}" — reading the neutral stdin event`);
    }
    event ??= parsePromptEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a prompt event ({session_id, prompt})');
      return;
    }
    const config = await loadVaultConfig(vaultRoot);
    const scope = invocation.scope ?? resolveScope(config, event.cwd);
    const { triggers, duplicates } = effectiveTriggers(
      config,
      scope,
      resolveFileTriggers(invocation)
    );
    for (const id of duplicates) {
      diag(`duplicate trigger id "${id}" — later occurrence ignored`);
    }
    const matches = matchPromptTriggers(event.prompt, triggers);
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
    const { vaultRoot } = invocation;
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
    const scope = invocation.scope ?? resolveScope(config, event.cwd);
    const { triggers, duplicates } = effectiveTriggers(
      config,
      scope,
      resolveFileTriggers(invocation)
    );
    for (const id of duplicates) {
      diag(`duplicate trigger id "${id}" — later occurrence ignored`);
    }
    const matches = matchPretoolTriggers(event.tool_name, event.tool_input, triggers, event.cwd);
    const { fired, skipped } = evaluateMatches(matches, vaultRoot);
    for (const id of skipped) {
      diag(`trigger "${id}": unknown or unevaluable predicate — skipped`);
    }
    const rendered = renderPretool(
      dedupePretoolMatches(hookStateDir(), event.session_id, fired),
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

/**
 * `kmd hook posttool [<vault-root>] [--harness claude]`. Fixed-function, not
 * trigger-driven: a tool call that wrote inside the vault runs validate
 * in-process; errors render as feedback and hold the sync, otherwise the
 * index syncs quietly. The resync protocol as an event instead of prose.
 * Fails open and exits 0 on every path, like the other hook events.
 */
export async function runHookPosttool(): Promise<void> {
  try {
    const invocation = hookInvocation();
    if (invocation === null) return;
    let format: 'neutral' | 'claude' = 'neutral';
    if (invocation.harness === 'claude') {
      format = 'claude';
    } else if (invocation.harness !== undefined) {
      diag(`unknown harness "${String(invocation.harness)}" — emitting the neutral contract`);
    }
    const event = parsePretoolEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a posttool event ({session_id, tool_name})');
      return;
    }
    if (!vaultPathTouched(event.tool_input, invocation.vaultRoot, event.cwd)) return;
    const config = await loadVaultConfig(invocation.vaultRoot);
    const findings = await validateVault(invocation.vaultRoot);
    let synced = false;
    if (!hasErrors(findings)) {
      try {
        await syncVault(invocation.vaultRoot);
        synced = true;
      } catch (err) {
        diag(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const rendered = renderPosttool(findings, synced, format, config.builtin_hooks?.resync ?? {});
    if (rendered !== null) {
      console.log(rendered);
    }
  } catch (err) {
    diag(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `kmd hook stop [<vault-root>] [--scope <s>]`. Fixed-function handoff gate:
 * a session ending inside a scope repo while the vault has validate errors is
 * sent back once with the fix list. Two loop guards run on every harness —
 * claude's `stop_hook_active` flag, and session-state dedup for harnesses
 * whose stop payload has no such flag (kiro-cli fires stop at every turn
 * end). The dedup token is spent only when a block actually renders, so a
 * clean handoff never consumes it. Fails open and exits 0 on every path.
 */
export async function runHookStop(): Promise<void> {
  try {
    const invocation = hookInvocation();
    if (invocation === null) return;
    const event = parseStopEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a stop event ({session_id})');
      return;
    }
    if (event.stop_hook_active === true) return;
    const config = await loadVaultConfig(invocation.vaultRoot);
    const scope = invocation.scope ?? resolveScope(config, event.cwd);
    if (scope === undefined) return;
    const rendered = renderStop(
      await validateVault(invocation.vaultRoot),
      config.builtin_hooks?.['handoff-gate']?.reason
    );
    if (rendered === null) return;
    const fired = dedupeMatches(hookStateDir(), event.session_id, [{ id: 'handoff-gate' }]);
    if (fired.length === 0) return;
    console.log(rendered);
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
