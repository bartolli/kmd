import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Trigger, VaultConfig } from './config.js';
import {
  dedupeMatches,
  dedupePretoolMatches,
  effectiveTriggers,
  matchPretoolTriggers,
  matchPromptTriggers,
  parsePretoolEvent,
  parsePromptEvent,
  renderPretool
} from './hook.js';

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

describe('matchPretoolTriggers / renderPretool', () => {
  const gate: Trigger = {
    id: 'retro-gate',
    on: 'pretool',
    enforce: 'block',
    tool: 'Bash',
    args_match: 'git tag',
    reason: 'Retro gate: no retro in scope newer than the last release note.'
  };

  it('denies a matched tool call with the authored reason (claude format)', () => {
    const { matches } = matchPretoolTriggers('Bash', { command: 'git tag v0.6.0' }, [gate]);
    const rendered = renderPretool(matches, 'claude');

    expect(rendered.stdout).not.toBeNull();
    const output = JSON.parse(rendered.stdout as string) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Retro gate');
  });

  it('stays silent when the tool name does not match', () => {
    const { matches } = matchPretoolTriggers('Write', { file_path: 'git tag.md' }, [gate]);

    expect(matches).toEqual([]);
    expect(renderPretool(matches, 'claude').stdout).toBeNull();
  });

  it('matches args_match anywhere in the serialized tool input', () => {
    const compound = matchPretoolTriggers('Bash', { command: 'cd /repo && git tag v2' }, [gate]);
    expect(compound.matches).toHaveLength(1);

    const anyTool: Trigger = { ...gate, id: 'any-tool-gate' };
    delete (anyTool as { tool?: string }).tool;
    const otherField = matchPretoolTriggers(
      'Write',
      { file_path: '/notes.md', content: 'run git tag v3 tomorrow' },
      [anyTool]
    );
    expect(otherField.matches).toHaveLength(1);
  });

  describe('with session state', () => {
    let stateDir: string;

    beforeEach(async () => {
      stateDir = await mkdtemp(join(tmpdir(), 'kmd-pretool-state-'));
    });

    afterEach(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const orient: Trigger = {
      id: 'tag-orientation',
      on: 'pretool',
      enforce: 'inject',
      tool: 'Bash',
      args_match: 'git tag',
      text: 'Tagging: ops-publish-kmd is the release chain.'
    };

    it('injects context without a permission decision, once per session', () => {
      const { matches } = matchPretoolTriggers('Bash', { command: 'git tag v1' }, [orient]);
      const rendered = renderPretool(dedupeMatches(stateDir, 's1', matches), 'claude');

      const output = JSON.parse(rendered.stdout as string) as {
        hookSpecificOutput: Record<string, string>;
      };
      expect(output.hookSpecificOutput.additionalContext).toContain('release chain');
      expect(output.hookSpecificOutput).not.toHaveProperty('permissionDecision');

      const again = matchPretoolTriggers('Bash', { command: 'git tag v2' }, [orient]);
      expect(dedupeMatches(stateDir, 's1', again.matches)).toEqual([]);
    });

    it('exempts block-class matches from dedup while inject-class dedups', () => {
      const event = () => matchPretoolTriggers('Bash', { command: 'git tag v1' }, [gate, orient]);

      const first = dedupePretoolMatches(stateDir, 's1', event().matches);
      expect(first.map((m) => m.id).sort()).toEqual(['retro-gate', 'tag-orientation']);

      const second = dedupePretoolMatches(stateDir, 's1', event().matches);
      expect(second.map((m) => m.id)).toEqual(['retro-gate']);
    });
  });

  it('maps warn-class matches to stderr with no stdout', () => {
    const cautious: Trigger = {
      id: 'force-push-caution',
      on: 'pretool',
      enforce: 'warn',
      tool: 'Bash',
      args_match: 'push --force',
      text: 'Force push against a shared branch.'
    };

    const { matches } = matchPretoolTriggers('Bash', { command: 'git push --force' }, [cautious]);
    const rendered = renderPretool(matches, 'claude');

    expect(rendered.stdout).toBeNull();
    expect(rendered.stderr).toEqual(['Force push against a shared branch.']);
  });

  it('combines a deny and injected context into one response, in both formats', () => {
    const orientation: Trigger = {
      id: 'tag-context',
      on: 'pretool',
      enforce: 'inject',
      args_match: 'git tag',
      text: 'Tag protocol: ops-publish-kmd.'
    };
    const { matches } = matchPretoolTriggers('Bash', { command: 'git tag v9' }, [
      gate,
      orientation
    ]);

    const claude = JSON.parse(renderPretool(matches, 'claude').stdout as string) as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(claude.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(claude.hookSpecificOutput.permissionDecisionReason).toContain('Retro gate');
    expect(claude.hookSpecificOutput.additionalContext).toBe('Tag protocol: ops-publish-kmd.');

    const neutral = JSON.parse(renderPretool(matches, 'neutral').stdout as string) as {
      decision: string;
      reason: string;
      context: string[];
      warnings: string[];
    };
    expect(neutral.decision).toBe('deny');
    expect(neutral.reason).toContain('Retro gate');
    expect(neutral.context).toEqual(['Tag protocol: ops-publish-kmd.']);
    expect(neutral.warnings).toEqual([]);
  });

  it('matches files globs against the path fields of the tool input', () => {
    const noDist: Trigger = {
      id: 'no-dist',
      on: 'pretool',
      enforce: 'block',
      files: ['dist/**'],
      reason: 'Generated output; edit the source.'
    };

    const hit = matchPretoolTriggers('Edit', { file_path: 'dist/kmd.mjs' }, [noDist]);
    expect(hit.matches.map((m) => m.id)).toEqual(['no-dist']);

    const miss = matchPretoolTriggers('Edit', { file_path: 'src/hook.ts' }, [noDist]);
    expect(miss.matches).toEqual([]);
  });

  it('pins glob semantics: * stays in a segment, ** crosses, **/ can be empty', () => {
    const trigger = (globs: string[]): Trigger => ({
      id: 'glob-pin',
      on: 'pretool',
      enforce: 'block',
      files: globs,
      reason: 'R.'
    });
    const matched = (globs: string[], path: string): boolean =>
      matchPretoolTriggers('Edit', { file_path: path }, [trigger(globs)]).matches.length > 0;

    expect(matched(['src/*.ts'], 'src/hook.ts')).toBe(true);
    expect(matched(['src/*.ts'], 'src/lib/fts.ts')).toBe(false);
    expect(matched(['src/**'], 'src/lib/fts.ts')).toBe(true);
    expect(matched(['**/*.lock'], 'sub/dir/x.lock')).toBe(true);
    expect(matched(['**/*.lock'], 'x.lock')).toBe(true);
    expect(matched(['file?.md'], 'file1.md')).toBe(true);
    expect(matched(['file?.md'], 'file/x.md')).toBe(false);
    expect(matched(['a.b'], 'axb')).toBe(false);
  });

  it('relativizes absolute tool-input paths against the event cwd', () => {
    const noDist: Trigger = {
      id: 'no-dist',
      on: 'pretool',
      enforce: 'block',
      files: ['dist/**'],
      reason: 'Generated output.'
    };

    const hit = matchPretoolTriggers(
      'Edit',
      { file_path: '/repo/dist/kmd.mjs' },
      [noDist],
      '/repo'
    );
    expect(hit.matches.map((m) => m.id)).toEqual(['no-dist']);

    const otherCwd = matchPretoolTriggers(
      'Edit',
      { file_path: '/elsewhere/dist/kmd.mjs' },
      [noDist],
      '/repo'
    );
    expect(otherCwd.matches).toEqual([]);
  });

  it('ANDs files with the tool matcher', () => {
    const editOnly: Trigger = {
      id: 'edit-dist',
      on: 'pretool',
      enforce: 'block',
      tool: 'Edit',
      files: ['dist/**'],
      reason: 'R.'
    };

    expect(
      matchPretoolTriggers('Edit', { file_path: 'dist/a.js' }, [editOnly]).matches
    ).toHaveLength(1);
    expect(matchPretoolTriggers('Read', { file_path: 'dist/a.js' }, [editOnly]).matches).toEqual(
      []
    );
  });

  it('skips a when-bearing trigger and reports it instead of gating', () => {
    const stateful: Trigger = { ...gate, id: 'stateful-gate', when: 'retro-fresh' };

    const { matches, skipped } = matchPretoolTriggers('Bash', { command: 'git tag v1' }, [
      stateful
    ]);

    expect(matches).toEqual([]);
    expect(skipped).toEqual(['stateful-gate']);
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

describe('parsePretoolEvent', () => {
  it('carries cwd for files-glob relativization', () => {
    const event = parsePretoolEvent(
      JSON.stringify({ session_id: 's1', tool_name: 'Edit', tool_input: {}, cwd: '/repo' })
    );

    expect(event?.cwd).toBe('/repo');
  });
});
