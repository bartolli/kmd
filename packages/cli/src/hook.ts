import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { resolveStateDir } from '@llm-wiki/db/database';
import { loadGlobalConfig, resolveVaultRoot } from '@llm-wiki/db/kmd-config';
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

/** Per-stage evidence for one prompt trigger; `unset` means not authored. */
interface PromptProbe {
  keywords: 'hit' | 'miss' | 'unset';
  intent: 'hit' | 'miss' | 'unset';
}

function promptProbe(
  trigger: InjectTrigger,
  prompt: string,
  getDb: () => DatabaseSync
): PromptProbe {
  let keywords: PromptProbe['keywords'] = 'unset';
  if (trigger.keywords !== undefined && trigger.keywords.length > 0) {
    const row = getDb()
      .prepare('SELECT count(*) AS n FROM prompt_doc WHERE prompt_doc MATCH ?')
      .get(keywordQuery(trigger.keywords)) as { n: number };
    keywords = row.n > 0 ? 'hit' : 'miss';
  }
  let intent: PromptProbe['intent'] = 'unset';
  if (trigger.intent !== undefined) {
    intent = trigger.intent.some((pattern) => new RegExp(pattern, 'i').test(prompt))
      ? 'hit'
      : 'miss';
  }
  return { keywords, intent };
}

function promptHit(probe: PromptProbe): boolean {
  return probe.keywords === 'hit' || probe.intent === 'hit';
}

function isInjectTrigger(trigger: Trigger): trigger is InjectTrigger {
  return trigger.on === 'prompt' && trigger.enforce === 'inject' && trigger.text !== undefined;
}

/**
 * Inject-class prompt triggers only (slice 1). Keywords match word-boundary
 * and porter-stemmed against an in-memory FTS5 table — the prompt is the
 * document, the author-controlled keywords are the query, so raw user text
 * never enters FTS5 query syntax. `intent` regexes run case-insensitive over
 * the raw prompt. The probe walk is shared with explain mode.
 */
export function matchPromptTriggers(prompt: string, triggers: Trigger[]): InjectMatch[] {
  const candidates = triggers.filter(isInjectTrigger);
  if (candidates.length === 0) return [];

  const matches: InjectMatch[] = [];
  const state: { db: DatabaseSync | null } = { db: null };
  const getDb = () => (state.db ??= openPromptIndex(prompt));
  try {
    for (const trigger of candidates) {
      if (!promptHit(promptProbe(trigger, prompt, getDb))) continue;
      matches.push({
        id: trigger.id,
        text: trigger.text,
        ...(trigger.dedup !== undefined && { dedup: trigger.dedup })
      });
    }
  } finally {
    state.db?.close();
  }
  return matches;
}

/** First-occurrence order; Set iteration pins the determinism. */
function uniqueTexts(texts: string[]): string[] {
  return [...new Set(texts)];
}

/**
 * Prompt renderer boundary: trigger identity and rendered payload are
 * separate concerns. Each matched id has already spent its own dedup key;
 * byte-identical text renders once.
 */
export function renderPrompt(matches: { id: string; text: string }[]): string[] {
  return uniqueTexts(matches.map((match) => match.text));
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

/**
 * One matcher walk serves enforcement and explain: `matchPretoolTriggers`
 * keeps the hits, the explain trace keeps every stage verdict — a second
 * hand-rolled walk would drift from the deny path it claims to explain.
 */
type PretoolStage = 'tool' | 'args' | 'files' | 'payload' | 'hit';

function pretoolStage(
  trigger: Trigger,
  toolName: string,
  toolInput: unknown,
  cwd?: string
): PretoolStage {
  // Case-folded: harnesses disagree on id casing (claude `Bash`, coco
  // `bash`) and no harness carries two tools differing only by case.
  if (trigger.tool !== undefined && trigger.tool.toLowerCase() !== toolName.toLowerCase()) {
    return 'tool';
  }
  if (trigger.args_match !== undefined) {
    const serialized = JSON.stringify(toolInput ?? {});
    if (!new RegExp(trigger.args_match).test(serialized)) return 'args';
  }
  if (trigger.files !== undefined && trigger.files.length > 0) {
    const candidates = [...pathCandidates(toolInput, cwd), ...patchPaths(toolInput)];
    const hit = trigger.files.some((glob) => {
      const regex = globToRegExp(glob);
      return candidates.some((candidate) => regex.test(candidate));
    });
    if (!hit) return 'files';
  }
  if (pretoolText(trigger) === undefined) return 'payload';
  return 'hit';
}

function pretoolText(trigger: Trigger): string | undefined {
  return trigger.enforce === 'block' ? trigger.reason : trigger.text;
}

function pretoolMatch(trigger: Trigger): PretoolMatch {
  return {
    id: trigger.id,
    enforce: trigger.enforce,
    text: pretoolText(trigger) as string,
    ...(trigger.when !== undefined && { when: trigger.when }),
    ...(trigger.dedup !== undefined && { dedup: trigger.dedup })
  };
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
    if (pretoolStage(trigger, toolName, toolInput, cwd) !== 'hit') continue;
    matches.push(pretoolMatch(trigger));
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

/**
 * Typed predicate evidence for explain mode; `evaluateWhen` projects it onto
 * the locked tri-state (satisfied/vacuous → allowed, unmet → fires,
 * unknown → skipped) so enforcement semantics stay byte-identical.
 */
export type WhenVerdict = 'satisfied' | 'unmet' | 'vacuous' | 'unknown';

function evaluateWhenVerdict(when: NonNullable<Trigger['when']>, vaultRoot: string): WhenVerdict {
  if (typeof when === 'string') return 'unknown';
  try {
    const than = newestUpdated(vaultRoot, when.than);
    if (than === null) return 'vacuous';
    const fresh = newestUpdated(vaultRoot, when.fresh);
    if (fresh === null) return 'unmet';
    return fresh >= than ? 'satisfied' : 'unmet';
  } catch {
    return 'unknown';
  }
}

function evaluateWhen(when: NonNullable<Trigger['when']>, vaultRoot: string): boolean | null {
  const verdict = evaluateWhenVerdict(when, vaultRoot);
  if (verdict === 'unknown') return null;
  return verdict !== 'unmet';
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
  // Identity and payload are separate: every id spent its own dedup key
  // upstream; here byte-identical text renders once and every unique block
  // reason reports in match order.
  const byClass = (enforce: PretoolMatch['enforce']): string[] =>
    uniqueTexts(matches.filter((match) => match.enforce === enforce).map((match) => match.text));
  const reasons = byClass('block');
  const context = byClass('inject');
  const warnings = byClass('warn');
  if (format === 'claude') {
    // "allow" would auto-approve the tool call; inject/warn must leave the
    // permission flow untouched, so the decision appears only on deny.
    const hookSpecificOutput: Record<string, string> = { hookEventName: 'PreToolUse' };
    if (reasons.length > 0) {
      hookSpecificOutput.permissionDecision = 'deny';
      hookSpecificOutput.permissionDecisionReason = reasons.join('\n');
    }
    if (context.length > 0) {
      hookSpecificOutput.additionalContext = context.join('\n');
    }
    const decided = reasons.length > 0 || context.length > 0;
    return { stdout: decided ? JSON.stringify({ hookSpecificOutput }) : null, stderr: warnings };
  }
  if (matches.length === 0) return { stdout: null, stderr: [] };
  return {
    stdout: JSON.stringify({
      decision: reasons.length > 0 ? 'deny' : 'none',
      ...(reasons.length > 0 && { reason: reasons.join('\n') }),
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
 * `mv`, `sed -i`, redirections, globs, variables. Tokens are quote-aware;
 * one counts as a path candidate when it carries a separator, a glob or
 * variable character, is a bare dot, or ends in a vault content extension.
 * Glob and variable targets resolve against the event cwd, so they register
 * only when the command runs inside the vault. Over-matching is safe
 * (validate + sync is idempotent); the silent miss is the failure mode this
 * closes. Paths built behind an in-command `cd` stay out of reach.
 */
const COMMAND_TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
const PATHISH_RE = /[/*$]|\.(?:md|base|canvas|ya?ml)$/i;

function commandPaths(toolInput: unknown): string[] {
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return [];
  const paths: string[] = [];
  for (const match of command.matchAll(COMMAND_TOKEN_RE)) {
    const token = (match[1] ?? match[2] ?? match[3]) as string;
    for (const piece of token.split(/[;|&<>()]+/)) {
      if (piece === '') continue;
      if (piece === '.' || piece === '..' || PATHISH_RE.test(piece)) paths.push(piece);
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
  matches: PretoolMatch[],
  persist = true
): PretoolMatch[] {
  const blocks = matches.filter((match) => match.enforce === 'block');
  const rest = matches.filter((match) => match.enforce !== 'block');
  const fresh = dedupeMatches(stateDir, sessionId, rest, Date.now(), persist);
  return matches.filter((match) => blocks.includes(match) || fresh.includes(match));
}

/** Session dedup state follows the vault's tier home; `kmd db reset` keeps it. */
export function hookStateDir(vaultRoot: string): string {
  return resolveStateDir(vaultRoot);
}

export type DedupVerdict = 'exempt' | 'never' | 'fresh' | 'suppressed';

export interface PromptExplainEntry {
  id: string;
  considered: boolean;
  keywords?: 'hit' | 'miss' | 'unset';
  intent?: 'hit' | 'miss' | 'unset';
  matched?: boolean;
  dedup?: DedupVerdict;
  fired?: boolean;
}

/**
 * Explain trace for a synthetic prompt event: per-trigger keyword and intent
 * evidence, dedup verdict, and the lines the harness would receive. Reads
 * dedup state, never writes it.
 */
export function explainPrompt(options: {
  prompt: string;
  triggers: Trigger[];
  stateDir: string;
  sessionId: string;
  now?: number;
}): { triggers: PromptExplainEntry[]; output: string[] } {
  const now = options.now ?? Date.now();
  const fired = readFired(join(options.stateDir, safeName(options.sessionId)));
  const entries: PromptExplainEntry[] = [];
  const rendered: { id: string; text: string }[] = [];
  const state: { db: DatabaseSync | null } = { db: null };
  const getDb = () => (state.db ??= openPromptIndex(options.prompt));
  try {
    for (const trigger of options.triggers) {
      if (!isInjectTrigger(trigger)) {
        entries.push({ id: trigger.id, considered: false });
        continue;
      }
      const probe = promptProbe(trigger, options.prompt, getDb);
      const matched = promptHit(probe);
      const entry: PromptExplainEntry = {
        id: trigger.id,
        considered: true,
        keywords: probe.keywords,
        intent: probe.intent,
        matched
      };
      entries.push(entry);
      if (!matched) {
        entry.fired = false;
        continue;
      }
      const key = dedupKey(trigger, now);
      entry.dedup = key === null ? 'never' : fired.has(key) ? 'suppressed' : 'fresh';
      entry.fired = entry.dedup !== 'suppressed';
      if (entry.fired) rendered.push({ id: trigger.id, text: trigger.text });
    }
  } finally {
    state.db?.close();
  }
  return { triggers: entries, output: renderPrompt(rendered) };
}

export interface PretoolExplainEntry {
  id: string;
  enforce?: Trigger['enforce'];
  considered: boolean;
  matcher?: 'hit' | 'tool-miss' | 'args-miss' | 'files-miss' | 'payload-miss';
  when?: WhenVerdict;
  dedup?: DedupVerdict;
  fired?: boolean;
}

/**
 * Explain trace for a synthetic pretool event: every trigger's stage
 * verdicts plus the outcome the harness would receive. Reads dedup state,
 * never writes it — a probe must not spend the session's noise budget.
 * Distinguishes the silent branches a live event conflates: matcher miss
 * (and which stage), predicate satisfied/vacuous/unknown, dedup
 * suppression.
 */
export function explainPretool(options: {
  toolName: string;
  toolInput: unknown;
  triggers: Trigger[];
  vaultRoot: string;
  stateDir: string;
  sessionId: string;
  cwd?: string;
  format?: 'neutral' | 'claude';
  now?: number;
}): { triggers: PretoolExplainEntry[]; outcome: { stdout: string | null; stderr: string[] } } {
  const now = options.now ?? Date.now();
  const fired = readFired(join(options.stateDir, safeName(options.sessionId)));
  const entries: PretoolExplainEntry[] = [];
  const rendered: PretoolMatch[] = [];
  for (const trigger of options.triggers) {
    if (trigger.on !== 'pretool') {
      entries.push({ id: trigger.id, considered: false });
      continue;
    }
    const stage = pretoolStage(trigger, options.toolName, options.toolInput, options.cwd);
    const entry: PretoolExplainEntry = {
      id: trigger.id,
      enforce: trigger.enforce,
      considered: true,
      matcher: stage === 'hit' ? 'hit' : `${stage}-miss`
    };
    entries.push(entry);
    if (stage !== 'hit') {
      entry.fired = false;
      continue;
    }
    if (trigger.when !== undefined) {
      entry.when = evaluateWhenVerdict(trigger.when, options.vaultRoot);
      if (entry.when !== 'unmet') {
        entry.fired = false;
        continue;
      }
    }
    const match = pretoolMatch(trigger);
    if (match.enforce === 'block') {
      entry.dedup = 'exempt';
    } else {
      const key = dedupKey(match, now);
      entry.dedup = key === null ? 'never' : fired.has(key) ? 'suppressed' : 'fresh';
    }
    entry.fired = entry.dedup !== 'suppressed';
    if (entry.fired) rendered.push(match);
  }
  return { triggers: entries, outcome: renderPretool(rendered, options.format ?? 'neutral') };
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
 * Stale sessions are pruned opportunistically on write. `persist: false`
 * classifies against existing state without recording — the dry-run path.
 */
export function dedupeMatches<T extends { id: string; dedup?: Trigger['dedup'] }>(
  stateDir: string,
  sessionId: string,
  matches: T[],
  now = Date.now(),
  persist = true
): T[] {
  if (matches.length === 0) return [];
  const dir = join(stateDir, safeName(sessionId));
  const fired = readFired(dir);
  const fresh: T[] = [];
  const record: string[] = [];
  for (const match of matches) {
    const key = dedupKey(match, now);
    if (key === null) {
      fresh.push(match);
      continue;
    }
    if (fired.has(key)) continue;
    fresh.push(match);
    record.push(key);
  }
  if (persist && record.length > 0) {
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

/** Null means dedup-exempt by policy (`never`): no key, no state spent. */
function dedupKey(match: { id: string; dedup?: Trigger['dedup'] }, now: number): string | null {
  if (match.dedup === 'never') return null;
  return safeName(
    typeof match.dedup === 'object'
      ? `${match.id}@${Math.floor(now / (match.dedup.minutes * 60_000))}`
      : match.id
  );
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
 * `kmd hook prompt [<vault-root>] [--default-root <path>] [--scope <s>]
 * [--harness kiro-ide]`. Exits 0
 * on every path and never throws: stdout is the harness's context-injection
 * channel, so a degraded gate engine emits one stderr diagnostic and injects
 * nothing — it must never block a prompt. `--harness` selects the input codec;
 * without it (claude, codex, kiro-cli) the event arrives as JSON on stdin.
 */
interface HookInvocation {
  positional: string | undefined;
  defaultRoot: string | undefined;
  scope: string | undefined;
  harness: unknown;
  triggersFile: unknown;
  /** True under `--dry-run` or `--explain`: no state writes, no side effects. */
  dryRun: boolean;
  explain: boolean;
}

function hookInvocation(): HookInvocation {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      scope: { type: 'string' },
      harness: { type: 'string' },
      triggers: { type: 'string' },
      'default-root': { type: 'string' },
      'dry-run': { type: 'boolean' },
      explain: { type: 'boolean' }
    }
  });
  return {
    positional: positionals[2],
    defaultRoot: typeof values['default-root'] === 'string' ? values['default-root'] : undefined,
    scope: typeof values.scope === 'string' ? values.scope : process.env.WIKI_SCOPE,
    harness: values.harness,
    triggersFile: values.triggers,
    dryRun: values['dry-run'] === true || values.explain === true,
    explain: values.explain === true
  };
}

/**
 * The one chain, hook edition: the project signal is the event-payload cwd,
 * never a harness env. Fail-open where operator commands fail loud — a
 * malformed config or unresolvable `${VAR}` degrades to one stderr line and
 * no gate work, because no sync beats syncing the wrong index. The unmarked
 * bare-`vault.yaml` skip stays silent here: hook stderr is the degradation
 * channel, and a skipped foreign file is correct resolution, not degradation.
 */
function resolveHookVault(invocation: HookInvocation, eventCwd: string | undefined): string | null {
  if (invocation.positional !== undefined && invocation.defaultRoot !== undefined) {
    diag('<vault-root> and --default-root are mutually exclusive — using the positional');
  }
  try {
    const resolution = resolveVaultRoot({
      positional: invocation.positional,
      projectDir: eventCwd,
      defaultRoot: invocation.defaultRoot,
      envVault: process.env.WIKI_VAULT,
      globalDefault: loadGlobalConfig().default_vault
    });
    if (resolution.root === null) {
      diag('no vault root resolvable (positional, event cwd, --default-root, or $WIKI_VAULT)');
      return null;
    }
    return resolution.root;
  } catch (err) {
    diag(`vault resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
    const vaultRoot = resolveHookVault(invocation, event.cwd);
    if (vaultRoot === null) return;
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
    if (invocation.explain) {
      const trace = explainPrompt({
        prompt: event.prompt,
        triggers,
        stateDir: hookStateDir(vaultRoot),
        sessionId: event.session_id
      });
      console.log(JSON.stringify({ event: 'prompt', scope: scope ?? null, duplicates, ...trace }));
      return;
    }
    const matches = matchPromptTriggers(event.prompt, triggers);
    const fresh = dedupeMatches(
      hookStateDir(vaultRoot),
      event.session_id,
      matches,
      Date.now(),
      !invocation.dryRun
    );
    for (const line of renderPrompt(fresh)) {
      console.log(line);
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
    const vaultRoot = resolveHookVault(invocation, event.cwd);
    if (vaultRoot === null) return;
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
    if (invocation.explain) {
      const trace = explainPretool({
        toolName: event.tool_name,
        toolInput: event.tool_input,
        triggers,
        vaultRoot,
        stateDir: hookStateDir(vaultRoot),
        sessionId: event.session_id,
        ...(event.cwd !== undefined && { cwd: event.cwd }),
        format
      });
      console.log(JSON.stringify({ event: 'pretool', scope: scope ?? null, duplicates, ...trace }));
      return;
    }
    const matches = matchPretoolTriggers(event.tool_name, event.tool_input, triggers, event.cwd);
    const { fired, skipped } = evaluateMatches(matches, vaultRoot);
    for (const id of skipped) {
      diag(`trigger "${id}": unknown or unevaluable predicate — skipped`);
    }
    const rendered = renderPretool(
      dedupePretoolMatches(hookStateDir(vaultRoot), event.session_id, fired, !invocation.dryRun),
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
    if (invocation.dryRun) {
      diag('--dry-run/--explain support prompt and pretool events only');
      return;
    }
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
    const vaultRoot = resolveHookVault(invocation, event.cwd);
    if (vaultRoot === null) return;
    if (!vaultPathTouched(event.tool_input, vaultRoot, event.cwd)) return;
    const config = await loadVaultConfig(vaultRoot);
    const findings = await validateVault(vaultRoot);
    let synced = false;
    if (!hasErrors(findings)) {
      try {
        await syncVault(vaultRoot);
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
    if (invocation.dryRun) {
      diag('--dry-run/--explain support prompt and pretool events only');
      return;
    }
    const event = parseStopEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a stop event ({session_id})');
      return;
    }
    if (event.stop_hook_active === true) return;
    const vaultRoot = resolveHookVault(invocation, event.cwd);
    if (vaultRoot === null) return;
    const config = await loadVaultConfig(vaultRoot);
    const scope = invocation.scope ?? resolveScope(config, event.cwd);
    if (scope === undefined) return;
    const rendered = renderStop(
      await validateVault(vaultRoot),
      config.builtin_hooks?.['handoff-gate']?.reason
    );
    if (rendered === null) return;
    const fired = dedupeMatches(hookStateDir(vaultRoot), event.session_id, [
      { id: 'handoff-gate' }
    ]);
    if (fired.length === 0) return;
    console.log(rendered);
  } catch (err) {
    diag(err instanceof Error ? err.message : String(err));
  }
}

export interface SessionStartEvent {
  session_id: string;
  cwd?: string;
  source?: string;
}

export function parseSessionStartEvent(raw: string): SessionStartEvent | null {
  const fields = eventFields(raw);
  if (fields === null) return null;
  const { session_id, cwd, source } = fields;
  if (typeof session_id !== 'string') return null;
  return {
    session_id,
    ...(typeof cwd === 'string' && { cwd }),
    ...(typeof source === 'string' && { source })
  };
}

/** Engine defaults for the orientation prose ([[adr-builtin-hook-identity]]). */
const ORIENT_TEXT =
  'prime via the wiki MCP prime tool (or `kmd prime <scope>` where the harness exposes ' +
  'no MCP tools) before substantive work — the primer carries current focus, book of ' +
  'work, and invariants.';
const REORIENT_TEXT =
  'context was compacted and transcript detail is lost — re-read the primer via the ' +
  'wiki MCP prime tool (or `kmd prime <scope>`) and route uncaptured findings into the ' +
  'wiki before continuing.';

/**
 * Session-orientation codec — public ids `orient` (fresh sources) and
 * `reorient` (`source: "compact"`). One line, stdout-as-context on every
 * harness that delivers SessionStart stdout to the model. The scope binding
 * is engine-owned; only the instruction prose is config.
 */
export function renderSessionStart(
  scope: string,
  source: string | undefined,
  messages: {
    orient?: { text?: string | undefined } | undefined;
    reorient?: { text?: string | undefined } | undefined;
  } = {}
): string {
  const text =
    source === 'compact'
      ? (messages.reorient?.text ?? REORIENT_TEXT)
      : (messages.orient?.text ?? ORIENT_TEXT);
  return `Wiki scope "${scope}": ${text}`;
}

/**
 * `kmd hook session-start [<vault-root>] [--scope <s>]`. Fixed-function
 * orientation: a session starting inside a declared scope repo receives one
 * stdout context line — the prime instruction, or the post-compaction
 * re-orientation when the harness reports `source: "compact"`. No resolved
 * scope means silence; no dedup state is read or written. Fails open and
 * exits 0 on every path like the other hook events.
 */
export async function runHookSessionStart(): Promise<void> {
  try {
    const invocation = hookInvocation();
    if (invocation.dryRun) {
      diag('--dry-run/--explain support prompt and pretool events only');
      return;
    }
    const event = parseSessionStartEvent(await readStdin());
    if (event === null) {
      diag('stdin is not a session-start event ({session_id})');
      return;
    }
    const vaultRoot = resolveHookVault(invocation, event.cwd);
    if (vaultRoot === null) return;
    const config = await loadVaultConfig(vaultRoot);
    const scope = invocation.scope ?? resolveScope(config, event.cwd);
    if (scope === undefined) return;
    console.log(renderSessionStart(scope, event.source, config.builtin_hooks ?? {}));
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
