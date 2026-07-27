import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Trigger, VaultConfig } from './config.js';
import { dedupeMatches, effectiveTriggers, matchPromptTriggers, parsePromptEvent } from './hook.js';

function injectTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'release-protocol',
    on: 'prompt',
    enforce: 'inject',
    keywords: ['release'],
    text: 'Release protocol: retro gates the tag.',
    ...overrides
  };
}

describe('matchPromptTriggers', () => {
  it('matches a literal keyword', () => {
    const matches = matchPromptTriggers("let's cut the release today", [injectTrigger()]);

    expect(matches).toEqual([
      { id: 'release-protocol', text: 'Release protocol: retro gates the tag.' }
    ]);
  });

  it('matches stemmed word forms of a keyword', () => {
    expect(matchPromptTriggers('releasing the new version', [injectTrigger()])).toHaveLength(1);
    expect(matchPromptTriggers('we released it yesterday', [injectTrigger()])).toHaveLength(1);
  });

  it('does not match a keyword inside a larger word', () => {
    expect(matchPromptTriggers('this is a prerelease build', [injectTrigger()])).toHaveLength(0);
  });

  it('treats a multi-word keyword as an adjacent phrase', () => {
    const trigger = injectTrigger({ keywords: ['git tag'] });

    expect(matchPromptTriggers('now run git tag v0.6.0', [trigger])).toHaveLength(1);
    expect(matchPromptTriggers('tag the git repo', [trigger])).toHaveLength(0);
  });

  it('falls back to intent regexes, case-insensitive', () => {
    const trigger = injectTrigger({ keywords: [], intent: ['cut (a )?Release'] });

    expect(matchPromptTriggers("let's cut a release", [trigger])).toHaveLength(1);
    expect(matchPromptTriggers('nothing relevant here', [trigger])).toHaveLength(0);
  });

  it('ignores pretool and non-inject triggers', () => {
    const pretool = injectTrigger({
      id: 'retro-gate',
      on: 'pretool',
      enforce: 'block',
      tool: 'Bash',
      args_match: 'git tag',
      reason: 'Retro gate.'
    });
    const warn = injectTrigger({ id: 'warned', enforce: 'warn' });

    expect(matchPromptTriggers('release the tag', [pretool, warn])).toHaveLength(0);
  });

  it('escapes embedded quotes in keywords instead of throwing', () => {
    const trigger = injectTrigger({ keywords: ['"release"'] });

    expect(matchPromptTriggers('cut the release', [trigger])).toHaveLength(1);
  });

  it('preserves trigger order across multiple matches', () => {
    const first = injectTrigger({ id: 'first', keywords: ['release'] });
    const second = injectTrigger({ id: 'second', keywords: ['tag'] });

    const matches = matchPromptTriggers('release and tag it', [first, second]);

    expect(matches.map((m) => m.id)).toEqual(['first', 'second']);
  });
});

describe('effectiveTriggers', () => {
  function config(overrides: Partial<VaultConfig> = {}): VaultConfig {
    return {
      scopes: { demo: { status: 'active' } },
      kinds: ['spec'],
      statuses: ['active'],
      methodologies: ['sdd'],
      tags: { canonical: [], aliases: {} },
      ...overrides
    };
  }

  it('returns engine defaults only when no scope is active', () => {
    expect(effectiveTriggers(config(), undefined)).toEqual([]);
  });

  it('returns an empty set for a scope with no trigger config', () => {
    expect(effectiveTriggers(config(), 'demo')).toEqual([]);
  });

  it('appends triggers_extra after the replaced base set', () => {
    const base = injectTrigger({ id: 'base' });
    const extra = injectTrigger({ id: 'extra' });
    const loaded = config({
      triggers: { demo: [base] },
      triggers_extra: { demo: [extra] }
    });

    expect(effectiveTriggers(loaded, 'demo').map((t) => t.id)).toEqual(['base', 'extra']);
  });

  it("does not leak another scope's triggers", () => {
    const loaded = config({ triggers_extra: { other: [injectTrigger()] } });

    expect(effectiveTriggers(loaded, 'demo')).toEqual([]);
  });
});

describe('dedupeMatches', () => {
  let stateDir: string;
  const match = { id: 'release-protocol', text: 'Release protocol.' };

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kmd-hook-state-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('passes matches through once, then filters them for the same session', () => {
    expect(dedupeMatches(stateDir, 's1', [match])).toEqual([match]);
    expect(dedupeMatches(stateDir, 's1', [match])).toEqual([]);
  });

  it('keeps sessions independent', () => {
    dedupeMatches(stateDir, 's1', [match]);

    expect(dedupeMatches(stateDir, 's2', [match])).toEqual([match]);
  });

  it('treats a corrupt state file as empty', () => {
    writeFileSync(join(stateDir, 's1.json'), 'not json');

    expect(dedupeMatches(stateDir, 's1', [match])).toEqual([match]);
  });

  it('creates no state for an empty match list', async () => {
    expect(dedupeMatches(stateDir, 's1', [])).toEqual([]);
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('prunes stale session files on write, keeping the current one', async () => {
    mkdirSync(stateDir, { recursive: true });
    const stale = join(stateDir, 'old-session.json');
    writeFileSync(stale, '["x"]');
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, eightDaysAgo, eightDaysAgo);

    dedupeMatches(stateDir, 's1', [match]);

    expect((await readdir(stateDir)).sort()).toEqual(['s1.json']);
  });

  it('sanitizes session ids used as filenames', async () => {
    dedupeMatches(stateDir, '../evil/../s1', [match]);

    const entries = await readdir(stateDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('/');
  });
});

describe('parsePromptEvent', () => {
  it('parses a payload carrying session_id and prompt', () => {
    const event = parsePromptEvent(
      JSON.stringify({ session_id: 's1', prompt: 'hello', cwd: '/x', extra: 1 })
    );

    expect(event).toEqual({ session_id: 's1', prompt: 'hello' });
  });

  it('returns null for malformed payloads', () => {
    expect(parsePromptEvent('not json')).toBeNull();
    expect(parsePromptEvent('null')).toBeNull();
    expect(parsePromptEvent(JSON.stringify({ prompt: 'no session' }))).toBeNull();
    expect(parsePromptEvent(JSON.stringify({ session_id: 's1' }))).toBeNull();
  });
});
