import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Trigger, VaultConfig } from '@llm-wiki/db/vault-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PretoolMatch } from './hook.js';
import {
  dedupeMatches,
  dedupePretoolMatches,
  effectiveTriggers,
  evaluateMatches,
  explainPretool,
  explainPrompt,
  kiroIdePromptEvent,
  loadTriggerFile,
  matchPretoolTriggers,
  matchPromptTriggers,
  parsePretoolEvent,
  parsePromptEvent,
  parseSessionStartEvent,
  parseStopEvent,
  renderPosttool,
  renderPretool,
  renderPrompt,
  renderSessionStart,
  renderStop,
  resolveScope,
  scanBacklog,
  sessionStartStdout,
  vaultPathTouched
} from './hook.js';
import type { Finding } from './validate.js';

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

describe('loadTriggerFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kmd-triggers-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a compiled trigger list and its triggers match', () => {
    const file = join(dir, 'triggers.yaml');
    writeFileSync(
      file,
      '- id: triage-skill\n  on: prompt\n  enforce: inject\n  keywords: [triage]\n  text: "Skill: /triage moves stories through the state machine."\n'
    );

    const triggers = loadTriggerFile(file);

    expect(triggers).not.toBeNull();
    const matches = matchPromptTriggers('please triage the backlog', triggers as Trigger[]);
    expect(matches.map((m) => m.id)).toEqual(['triage-skill']);
  });

  it('returns null for a missing or schema-invalid triggers file', () => {
    expect(loadTriggerFile(join(dir, 'nope.yaml'))).toBeNull();

    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, '- id: bare\n  on: prompt\n  enforce: inject\n  text: "T."\n');
    expect(loadTriggerFile(bad)).toBeNull();
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
    expect(effectiveTriggers(config(), undefined).triggers).toEqual([]);
  });

  it('returns an empty set for a scope with no trigger config', () => {
    expect(effectiveTriggers(config(), 'demo').triggers).toEqual([]);
  });

  it('appends triggers_extra after the replaced base set', () => {
    const base = injectTrigger({ id: 'base' });
    const extra = injectTrigger({ id: 'extra' });
    const loaded = config({
      triggers: { demo: [base] },
      triggers_extra: { demo: [extra] }
    });

    expect(effectiveTriggers(loaded, 'demo').triggers.map((t) => t.id)).toEqual(['base', 'extra']);
  });

  it("does not leak another scope's triggers", () => {
    const loaded = config({ triggers_extra: { other: [injectTrigger()] } });

    expect(effectiveTriggers(loaded, 'demo').triggers).toEqual([]);
  });

  it('appends file triggers after defaults and before scope extras', () => {
    const file = injectTrigger({ id: 'from-file' });
    const extra = injectTrigger({ id: 'extra' });
    const loaded = config({ triggers_extra: { demo: [extra] } });

    const { triggers } = effectiveTriggers(loaded, 'demo', [file]);

    expect(triggers.map((t) => t.id)).toEqual(['from-file', 'extra']);
  });

  it('drops file triggers under a full-replace triggers section', () => {
    const file = injectTrigger({ id: 'from-file' });
    const replace = injectTrigger({ id: 'replace' });
    const loaded = config({ triggers: { demo: [replace] } });

    const { triggers } = effectiveTriggers(loaded, 'demo', [file]);

    expect(triggers.map((t) => t.id)).toEqual(['replace']);
  });

  it('fires file triggers with no active scope', () => {
    const { triggers } = effectiveTriggers(config(), undefined, [
      injectTrigger({ id: 'from-file' })
    ]);

    expect(triggers.map((t) => t.id)).toEqual(['from-file']);
  });

  it('fires _all extras with no active scope', () => {
    const loaded = config({ triggers_extra: { _all: [injectTrigger({ id: 'global' })] } });

    expect(effectiveTriggers(loaded, undefined).triggers.map((t) => t.id)).toEqual(['global']);
  });

  it('appends _all extras before scope extras, surviving a full-replace', () => {
    const loaded = config({
      triggers: { demo: [injectTrigger({ id: 'replace' })] },
      triggers_extra: {
        _all: [injectTrigger({ id: 'global' })],
        demo: [injectTrigger({ id: 'scoped' })]
      }
    });

    expect(effectiveTriggers(loaded, 'demo').triggers.map((t) => t.id)).toEqual([
      'replace',
      'global',
      'scoped'
    ]);
  });

  it('keeps the first occurrence of a duplicate id and reports the rest', () => {
    const file = injectTrigger({ id: 'dup', text: 'from file' });
    const extra = injectTrigger({ id: 'dup', text: 'from vault' });
    const loaded = config({ triggers_extra: { demo: [extra] } });

    const { triggers, duplicates } = effectiveTriggers(loaded, 'demo', [file]);

    expect(triggers.map((t) => t.text)).toEqual(['from file']);
    expect(duplicates).toEqual(['dup']);
  });
});

describe('resolveScope', () => {
  function config(repos: Record<string, string | undefined>): VaultConfig {
    const scopes: VaultConfig['scopes'] = {};
    for (const [name, repo] of Object.entries(repos)) {
      scopes[name] = { status: 'active', ...(repo !== undefined && { repo }) };
    }
    return {
      scopes,
      kinds: ['spec'],
      statuses: ['active'],
      methodologies: ['sdd'],
      tags: { canonical: [], aliases: {} }
    };
  }

  it('resolves the scope whose repo contains the event cwd', () => {
    const loaded = config({ codanna: '/p/codanna', svlint: '/p/svlint' });

    expect(resolveScope(loaded, '/p/codanna/src/lib')).toBe('codanna');
    expect(resolveScope(loaded, '/p/codanna')).toBe('codanna');
    expect(resolveScope(loaded, '/p/elsewhere')).toBeUndefined();
  });

  it('matches on path boundaries, not string prefixes', () => {
    const loaded = config({ codanna: '/p/codanna' });

    expect(resolveScope(loaded, '/p/codanna-web/src')).toBeUndefined();
  });

  it('prefers the longest declared repo for nested checkouts', () => {
    const loaded = config({ umbrella: '/p', codanna: '/p/codanna' });

    expect(resolveScope(loaded, '/p/codanna/src')).toBe('codanna');
    expect(resolveScope(loaded, '/p/other')).toBe('umbrella');
  });

  it('expands ~ in repo values and ignores relative ones', () => {
    const loaded = config({ home: '~/proj/x', rel: 'not/absolute' });

    expect(resolveScope(loaded, join(homedir(), 'proj/x/sub'))).toBe('home');
    expect(resolveScope(loaded, 'not/absolute/sub')).toBeUndefined();
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

  it('ignores legacy array-file session state', () => {
    writeFileSync(join(stateDir, 's1.json'), '["release-protocol"]');

    expect(dedupeMatches(stateDir, 's1', [match])).toEqual([match]);
  });

  it('creates no state for an empty match list', async () => {
    expect(dedupeMatches(stateDir, 's1', [])).toEqual([]);
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('prunes stale session state on write — legacy files and dirs — keeping the current one', async () => {
    mkdirSync(join(stateDir, 'old-session'), { recursive: true });
    writeFileSync(join(stateDir, 'old-session', 'x'), '');
    const staleFile = join(stateDir, 'legacy-session.json');
    writeFileSync(staleFile, '["x"]');
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(staleFile, eightDaysAgo, eightDaysAgo);
    utimesSync(join(stateDir, 'old-session'), eightDaysAgo, eightDaysAgo);

    dedupeMatches(stateDir, 's1', [match]);

    expect((await readdir(stateDir)).sort()).toEqual(['s1']);
  });

  it('sanitizes session ids used as filenames', async () => {
    dedupeMatches(stateDir, '../evil/../s1', [match]);

    const entries = await readdir(stateDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('/');
  });

  it('returns matches unchanged when the state dir is unwritable', () => {
    const blocked = join(stateDir, 'occupied-by-file');
    writeFileSync(blocked, 'not a directory');

    expect(dedupeMatches(blocked, 's1', [match])).toEqual([match]);
  });

  it('records each dedup key as its own atomic marker inside a per-session dir', async () => {
    const bucketed = { id: 'minute-brief', text: 'M.', dedup: { minutes: 10 } };

    dedupeMatches(stateDir, 's1', [match, bucketed], 600_000);

    expect((await readdir(join(stateDir, 's1'))).sort()).toEqual([
      'minute-brief@1',
      'release-protocol'
    ]);
  });

  it('filters without recording when persistence is off', async () => {
    expect(dedupeMatches(stateDir, 's1', [match], Date.now(), false)).toEqual([match]);
    expect(await readdir(stateDir)).toEqual([]);

    dedupeMatches(stateDir, 's1', [match]);
    expect(dedupeMatches(stateDir, 's1', [match], Date.now(), false)).toEqual([]);
  });

  it('lets the handoff-gate block through a state failure', () => {
    const blocked = join(stateDir, 'occupied-by-file');
    writeFileSync(blocked, 'not a directory');

    expect(dedupeMatches(blocked, 's1', [{ id: 'handoff-gate' }])).toEqual([
      { id: 'handoff-gate' }
    ]);
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
    const matches = matchPretoolTriggers('Bash', { command: 'git tag v0.6.0' }, [gate]);
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
    const matches = matchPretoolTriggers('Write', { file_path: 'git tag.md' }, [gate]);

    expect(matches).toEqual([]);
    expect(renderPretool(matches, 'claude').stdout).toBeNull();
  });

  it('matches the authored tool name across id casings — coco sends lowercase', () => {
    const coco = matchPretoolTriggers('bash', { command: 'git tag v0.6.0' }, [gate]);
    expect(coco).toHaveLength(1);

    const otherTool = matchPretoolTriggers('write', { command: 'git tag v0.6.0' }, [gate]);
    expect(otherTool).toEqual([]);
  });

  it('matches args_match anywhere in the serialized tool input', () => {
    const compound = matchPretoolTriggers('Bash', { command: 'cd /repo && git tag v2' }, [gate]);
    expect(compound).toHaveLength(1);

    const anyTool: Trigger = { ...gate, id: 'any-tool-gate' };
    delete (anyTool as { tool?: string }).tool;
    const otherField = matchPretoolTriggers(
      'Write',
      { file_path: '/notes.md', content: 'run git tag v3 tomorrow' },
      [anyTool]
    );
    expect(otherField).toHaveLength(1);
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
      const matches = matchPretoolTriggers('Bash', { command: 'git tag v1' }, [orient]);
      const rendered = renderPretool(dedupeMatches(stateDir, 's1', matches), 'claude');

      const output = JSON.parse(rendered.stdout as string) as {
        hookSpecificOutput: Record<string, string>;
      };
      expect(output.hookSpecificOutput.additionalContext).toContain('release chain');
      expect(output.hookSpecificOutput).not.toHaveProperty('permissionDecision');

      const again = matchPretoolTriggers('Bash', { command: 'git tag v2' }, [orient]);
      expect(dedupeMatches(stateDir, 's1', again)).toEqual([]);
    });

    it('exempts block-class matches from dedup while inject-class dedups', () => {
      const event = () => matchPretoolTriggers('Bash', { command: 'git tag v1' }, [gate, orient]);

      const first = dedupePretoolMatches(stateDir, 's1', event());
      expect(first.map((m) => m.id).sort()).toEqual(['retro-gate', 'tag-orientation']);

      const second = dedupePretoolMatches(stateDir, 's1', event());
      expect(second.map((m) => m.id)).toEqual(['retro-gate']);
    });

    it('preserves a mixed block + inject deny when the state dir is unwritable', () => {
      const blocked = join(stateDir, 'occupied-by-file');
      writeFileSync(blocked, 'not a directory');
      const matches = matchPretoolTriggers('Bash', { command: 'git tag v1' }, [gate, orient]);

      const rendered = renderPretool(dedupePretoolMatches(blocked, 's1', matches), 'claude');

      const output = JSON.parse(rendered.stdout as string) as {
        hookSpecificOutput: Record<string, string>;
      };
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Retro gate');
      expect(output.hookSpecificOutput.additionalContext).toContain('release chain');
    });
  });

  it('reports every unique block reason in match order', () => {
    const matches: PretoolMatch[] = [
      { id: 'gate-a', enforce: 'block', text: 'Reason A.' },
      { id: 'gate-b', enforce: 'block', text: 'Reason B.' },
      { id: 'gate-a-twin', enforce: 'block', text: 'Reason A.' }
    ];

    const claude = JSON.parse(renderPretool(matches, 'claude').stdout as string) as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(claude.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(claude.hookSpecificOutput.permissionDecisionReason).toBe('Reason A.\nReason B.');

    const neutral = JSON.parse(renderPretool(matches, 'neutral').stdout as string) as {
      decision: string;
      reason: string;
    };
    expect(neutral.decision).toBe('deny');
    expect(neutral.reason).toBe('Reason A.\nReason B.');
  });

  it('coalesces identical inject and warn text', () => {
    const matches: PretoolMatch[] = [
      { id: 'brief-a', enforce: 'inject', text: 'Same brief.' },
      { id: 'brief-b', enforce: 'inject', text: 'Same brief.' },
      { id: 'warn-a', enforce: 'warn', text: 'Same warning.' },
      { id: 'warn-b', enforce: 'warn', text: 'Same warning.' }
    ];

    const claude = renderPretool(matches, 'claude');
    const output = JSON.parse(claude.stdout as string) as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(output.hookSpecificOutput.additionalContext).toBe('Same brief.');
    expect(claude.stderr).toEqual(['Same warning.']);

    const neutral = JSON.parse(renderPretool(matches, 'neutral').stdout as string) as {
      context: string[];
      warnings: string[];
    };
    expect(neutral.context).toEqual(['Same brief.']);
    expect(neutral.warnings).toEqual(['Same warning.']);
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

    const matches = matchPretoolTriggers('Bash', { command: 'git push --force' }, [cautious]);
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
    const matches = matchPretoolTriggers('Bash', { command: 'git tag v9' }, [gate, orientation]);

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
    expect(hit.map((m) => m.id)).toEqual(['no-dist']);

    const miss = matchPretoolTriggers('Edit', { file_path: 'src/hook.ts' }, [noDist]);
    expect(miss).toEqual([]);
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
      matchPretoolTriggers('Edit', { file_path: path }, [trigger(globs)]).length > 0;

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
    expect(hit.map((m) => m.id)).toEqual(['no-dist']);

    const otherCwd = matchPretoolTriggers(
      'Edit',
      { file_path: '/elsewhere/dist/kmd.mjs' },
      [noDist],
      '/repo'
    );
    expect(otherCwd).toEqual([]);
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

    expect(matchPretoolTriggers('Edit', { file_path: 'dist/a.js' }, [editOnly])).toHaveLength(1);
    expect(matchPretoolTriggers('Read', { file_path: 'dist/a.js' }, [editOnly])).toEqual([]);
  });

  describe('evaluateMatches (newer-than)', () => {
    let vaultRoot: string;

    beforeEach(async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'kmd-when-vault-'));
    });

    afterEach(async () => {
      await rm(vaultRoot, { recursive: true, force: true });
    });

    function page(rel: string, updated: string): void {
      const path = join(vaultRoot, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `---\ntitle: p\nupdated: ${updated}\n---\nbody\n`);
    }

    function gated(): PretoolMatch {
      return {
        id: 'retro-gate',
        enforce: 'block',
        text: 'Retro gate.',
        when: {
          name: 'newer-than',
          fresh: ['notes/demo-retro-*.md'],
          than: ['projects/demo/ops/release-*.md']
        }
      };
    }

    it('suppresses the gate when the fresh side outdates the anchor', () => {
      page('notes/demo-retro-1.md', '2026-07-26');
      page('projects/demo/ops/release-1.md', '2026-07-20');

      const { fired, skipped } = evaluateMatches([gated()], vaultRoot);

      expect(fired).toEqual([]);
      expect(skipped).toEqual([]);
    });

    it('fires the gate when the retro is older or missing', () => {
      page('notes/demo-retro-1.md', '2026-07-10');
      page('projects/demo/ops/release-1.md', '2026-07-20');
      expect(evaluateMatches([gated()], vaultRoot).fired.map((m) => m.id)).toEqual(['retro-gate']);

      rmSync(join(vaultRoot, 'notes/demo-retro-1.md'));
      expect(evaluateMatches([gated()], vaultRoot).fired.map((m) => m.id)).toEqual(['retro-gate']);
    });

    it('passes vacuously when the anchor side matches nothing', () => {
      page('notes/demo-retro-1.md', '2026-07-10');

      expect(evaluateMatches([gated()], vaultRoot).fired).toEqual([]);
    });

    it('orders within a day when updated carries a UTC timestamp', () => {
      page('notes/demo-retro-1.md', '"2026-09-02T14:30:00Z"');
      page('projects/demo/ops/release-1.md', '"2026-09-02T16:05:00Z"');
      expect(evaluateMatches([gated()], vaultRoot).fired.map((m) => m.id)).toEqual(['retro-gate']);

      page('notes/demo-retro-1.md', '"2026-09-02T16:06:00Z"');
      expect(evaluateMatches([gated()], vaultRoot).fired).toEqual([]);
    });

    it('treats a same-day tie as fresh', () => {
      page('notes/demo-retro-1.md', '2026-07-26');
      page('projects/demo/ops/release-1.md', '2026-07-26');

      expect(evaluateMatches([gated()], vaultRoot).fired).toEqual([]);
    });

    it('skips unknown predicates and passes through unconditional matches', () => {
      const plain: PretoolMatch = { id: 'plain', enforce: 'block', text: 'R.' };
      const named: PretoolMatch = { ...plain, id: 'legacy', when: 'retro-fresh' };

      const { fired, skipped } = evaluateMatches([plain, named], vaultRoot);

      expect(fired.map((m) => m.id)).toEqual(['plain']);
      expect(skipped).toEqual(['legacy']);
    });

    it('ignores pages without a parseable updated date', () => {
      const path = join(vaultRoot, 'notes/demo-retro-1.md');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'no frontmatter at all\n');
      page('projects/demo/ops/release-1.md', '2026-07-20');

      expect(evaluateMatches([gated()], vaultRoot).fired.map((m) => m.id)).toEqual(['retro-gate']);
    });
  });
});

describe('scanBacklog', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'kmd-band-vault-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  function page(rel: string, frontmatter: string, body = 'body\n'): void {
    const path = join(vaultRoot, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\n${frontmatter}\n---\n${body}`);
  }

  it('counts ready-for-agent stories with zero ticks older than thirty days, and draft intents', () => {
    const now = new Date('2026-09-02T12:00:00Z');
    page(
      'projects/demo/plan/p/story-1-old.md',
      'title: Old\nkind: story\nstatus: active\ntriage_state: ready-for-agent\nupdated: "2026-07-20T00:00:00Z"',
      '- [ ] **Slice 1** — x\n'
    );
    page(
      'projects/demo/plan/p/story-2-fresh.md',
      'title: Fresh\nkind: story\nstatus: active\ntriage_state: ready-for-agent\nupdated: "2026-09-01T00:00:00Z"',
      '- [ ] **Slice 1** — x\n'
    );
    page(
      'projects/demo/plan/p/story-3-started.md',
      'title: Started\nkind: story\nstatus: active\ntriage_state: ready-for-agent\nupdated: "2026-07-01T00:00:00Z"',
      '- [x] **Slice 1** — x\n- [ ] **Slice 2** — y\n'
    );
    page('projects/demo/intent/intent-a.md', 'title: A\nkind: intent\nstatus: draft\nsightings: 1');
    page(
      'projects/demo/intent/intent-b.md',
      'title: B\nkind: intent\nstatus: archived\nsightings: 2'
    );
    page(
      'projects/other/intent/intent-c.md',
      'title: C\nkind: intent\nstatus: draft\nsightings: 1'
    );

    expect(scanBacklog(vaultRoot, 'demo', now)).toEqual({ stale: 1, draftIntents: 1 });
  });

  it('returns zeros for a scope with no stories or intents', () => {
    expect(scanBacklog(vaultRoot, 'demo', new Date())).toEqual({ stale: 0, draftIntents: 0 });
  });
});

describe('parsePromptEvent', () => {
  it('parses a payload carrying session_id and prompt', () => {
    const event = parsePromptEvent(
      JSON.stringify({ session_id: 's1', prompt: 'hello', cwd: '/x', extra: 1 })
    );

    expect(event).toEqual({ session_id: 's1', prompt: 'hello', cwd: '/x' });
  });

  it('returns null for malformed payloads', () => {
    expect(parsePromptEvent('not json')).toBeNull();
    expect(parsePromptEvent('null')).toBeNull();
    expect(parsePromptEvent(JSON.stringify({ prompt: 'no session' }))).toBeNull();
    expect(parsePromptEvent(JSON.stringify({ session_id: 's1' }))).toBeNull();
  });
});

describe('parsePromptEvent cwd', () => {
  it('carries cwd for repo-based scope resolution', () => {
    const event = parsePromptEvent(
      JSON.stringify({ session_id: 's1', prompt: 'hi', cwd: '/p/codanna' })
    );

    expect(event?.cwd).toBe('/p/codanna');
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

describe('explainPretool', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kmd-explain-state-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const gate: Trigger = {
    id: 'retro-gate',
    on: 'pretool',
    enforce: 'block',
    tool: 'Bash',
    args_match: 'git tag',
    reason: 'Retro gate.'
  };
  const orient: Trigger = {
    id: 'tag-orientation',
    on: 'pretool',
    enforce: 'inject',
    tool: 'Bash',
    args_match: 'git tag',
    text: 'Tagging: ops-publish-kmd is the release chain.'
  };

  it('traces a matched deny end to end without touching state', async () => {
    const trace = explainPretool({
      toolName: 'Bash',
      toolInput: { command: 'git tag v1' },
      triggers: [gate, orient],
      vaultRoot: '/nonexistent-vault',
      stateDir,
      sessionId: 's1',
      format: 'claude'
    });

    expect(trace.triggers).toEqual([
      {
        id: 'retro-gate',
        enforce: 'block',
        considered: true,
        matcher: 'hit',
        dedup: 'exempt',
        fired: true
      },
      {
        id: 'tag-orientation',
        enforce: 'inject',
        considered: true,
        matcher: 'hit',
        dedup: 'fresh',
        fired: true
      }
    ]);
    const output = JSON.parse(trace.outcome.stdout as string) as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.additionalContext).toContain('release chain');
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('names the matcher stage that missed, per trigger', () => {
    const filesGate: Trigger = {
      id: 'dist-gate',
      on: 'pretool',
      enforce: 'block',
      tool: 'Bash',
      files: ['dist/**'],
      reason: 'R.'
    };
    const promptTrigger: Trigger = {
      id: 'release-protocol',
      on: 'prompt',
      enforce: 'inject',
      text: 'T.'
    };

    const trace = explainPretool({
      toolName: 'Bash',
      toolInput: { command: 'git push', file_path: 'src/a.ts' },
      triggers: [
        gate,
        orient,
        filesGate,
        promptTrigger,
        { ...gate, id: 'wrong-tool', tool: 'Write' }
      ],
      vaultRoot: '/nonexistent-vault',
      stateDir,
      sessionId: 's1'
    });

    expect(trace.triggers).toEqual([
      { id: 'retro-gate', enforce: 'block', considered: true, matcher: 'args-miss', fired: false },
      {
        id: 'tag-orientation',
        enforce: 'inject',
        considered: true,
        matcher: 'args-miss',
        fired: false
      },
      { id: 'dist-gate', enforce: 'block', considered: true, matcher: 'files-miss', fired: false },
      { id: 'release-protocol', considered: false },
      { id: 'wrong-tool', enforce: 'block', considered: true, matcher: 'tool-miss', fired: false }
    ]);
    expect(trace.outcome.stdout).toBeNull();
  });

  it('reports typed predicate evidence without changing enforcement', () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), 'kmd-explain-vault-'));
    const page = (rel: string, updated: string): void => {
      const path = join(vaultRoot, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `---\ntitle: p\nupdated: ${updated}\n---\nbody\n`);
    };
    const when = (id: string, fresh: string, than: string): Trigger => ({
      ...gate,
      id,
      when: { name: 'newer-than', fresh: [fresh], than: [than] }
    });
    page('notes/retro-1.md', '2026-07-10');
    page('ops/release-1.md', '2026-07-20');
    page('notes/fresh-retro.md', '2026-07-26');

    const trace = explainPretool({
      toolName: 'Bash',
      toolInput: { command: 'git tag v1' },
      triggers: [
        when('unmet-gate', 'notes/retro-*.md', 'ops/release-*.md'),
        when('satisfied-gate', 'notes/fresh-*.md', 'ops/release-*.md'),
        when('vacuous-gate', 'notes/retro-*.md', 'ops/absent-*.md'),
        { ...gate, id: 'unknown-gate', when: 'legacy-name' as Trigger['when'] } as Trigger
      ],
      vaultRoot,
      stateDir,
      sessionId: 's1'
    });

    rmSync(vaultRoot, { recursive: true, force: true });
    expect(trace.triggers.map((t) => ({ id: t.id, when: t.when, fired: t.fired }))).toEqual([
      { id: 'unmet-gate', when: 'unmet', fired: true },
      { id: 'satisfied-gate', when: 'satisfied', fired: false },
      { id: 'vacuous-gate', when: 'vacuous', fired: false },
      { id: 'unknown-gate', when: 'unknown', fired: false }
    ]);
  });

  it('classifies dedup per trigger and never writes state', async () => {
    dedupeMatches(stateDir, 's1', [{ id: 'tag-orientation' }]);
    const never: Trigger = { ...orient, id: 'always-on', dedup: 'never' };

    const probe = () =>
      explainPretool({
        toolName: 'Bash',
        toolInput: { command: 'git tag v1' },
        triggers: [gate, orient, never],
        vaultRoot: '/nonexistent-vault',
        stateDir,
        sessionId: 's1'
      });

    const verdicts = (trace: ReturnType<typeof probe>) =>
      trace.triggers.map((t) => ({ id: t.id, dedup: t.dedup, fired: t.fired }));
    const expected = [
      { id: 'retro-gate', dedup: 'exempt', fired: true },
      { id: 'tag-orientation', dedup: 'suppressed', fired: false },
      { id: 'always-on', dedup: 'never', fired: true }
    ];
    expect(verdicts(probe())).toEqual(expected);
    expect(verdicts(probe())).toEqual(expected);
    expect(await readdir(join(stateDir, 's1'))).toEqual(['tag-orientation']);
  });
});

describe('renderPrompt', () => {
  it('coalesces identical payload text while each id spends its own dedup key', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'kmd-render-prompt-'));
    const twins = [
      { id: 'release-protocol', text: 'Release protocol.' },
      { id: 'release-tag-moment', text: 'Release protocol.' }
    ];

    const lines = renderPrompt(dedupeMatches(stateDir, 's1', twins));

    expect(lines).toEqual(['Release protocol.']);
    expect((await readdir(join(stateDir, 's1'))).sort()).toEqual([
      'release-protocol',
      'release-tag-moment'
    ]);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('keeps distinct texts in match order', () => {
    expect(
      renderPrompt([
        { id: 'a', text: 'First.' },
        { id: 'b', text: 'Second.' },
        { id: 'c', text: 'First.' }
      ])
    ).toEqual(['First.', 'Second.']);
  });
});

describe('explainPrompt', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kmd-explain-prompt-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const brief: Trigger = {
    id: 'release-protocol',
    on: 'prompt',
    enforce: 'inject',
    keywords: ['release'],
    intent: ['\\btag\\b'],
    text: 'Release protocol.'
  };

  it('traces keyword and intent evidence with dedup, without writing state', async () => {
    dedupeMatches(stateDir, 's1', [{ id: 'suppressed-brief' }]);
    const suppressed: Trigger = { ...brief, id: 'suppressed-brief' };
    const missed: Trigger = {
      ...brief,
      id: 'missed-brief',
      keywords: ['deploy'],
      intent: ['\\bship\\b']
    };
    const pretool: Trigger = { id: 'retro-gate', on: 'pretool', enforce: 'block', reason: 'R.' };

    const trace = explainPrompt({
      prompt: 'releasing the train today',
      triggers: [brief, suppressed, missed, pretool],
      stateDir,
      sessionId: 's1'
    });

    expect(trace.triggers).toEqual([
      {
        id: 'release-protocol',
        considered: true,
        keywords: 'hit',
        intent: 'miss',
        matched: true,
        dedup: 'fresh',
        fired: true
      },
      {
        id: 'suppressed-brief',
        considered: true,
        keywords: 'hit',
        intent: 'miss',
        matched: true,
        dedup: 'suppressed',
        fired: false
      },
      {
        id: 'missed-brief',
        considered: true,
        keywords: 'miss',
        intent: 'miss',
        matched: false,
        fired: false
      },
      { id: 'retro-gate', considered: false }
    ]);
    expect(trace.output).toEqual(['Release protocol.']);
    expect(await readdir(join(stateDir, 's1'))).toEqual(['suppressed-brief']);
  });

  it('coalesces identical payload text while tracing each id separately', () => {
    const twin: Trigger = { ...brief, id: 'release-tag-moment' };

    const trace = explainPrompt({
      prompt: 'releasing today',
      triggers: [brief, twin],
      stateDir,
      sessionId: 's1'
    });

    expect(trace.triggers.map((t) => ({ id: t.id, fired: t.fired }))).toEqual([
      { id: 'release-protocol', fired: true },
      { id: 'release-tag-moment', fired: true }
    ]);
    expect(trace.output).toEqual(['Release protocol.']);
  });
});

describe('parseSessionStartEvent', () => {
  it('parses session_id with optional cwd and source', () => {
    expect(
      parseSessionStartEvent(
        JSON.stringify({ session_id: 's1', cwd: '/repo', source: 'compact', extra: 1 })
      )
    ).toEqual({ session_id: 's1', cwd: '/repo', source: 'compact' });
    expect(parseSessionStartEvent(JSON.stringify({ session_id: 's1' }))).toEqual({
      session_id: 's1'
    });
  });

  it('returns null for malformed payloads', () => {
    expect(parseSessionStartEvent('not json')).toBeNull();
    expect(parseSessionStartEvent(JSON.stringify({ source: 'startup' }))).toBeNull();
  });
});

describe('renderSessionStart', () => {
  it('orients a fresh session with the resolved scope and prime instruction', () => {
    const line = renderSessionStart('llm-wiki', 'startup');

    expect(line).toContain('"llm-wiki"');
    expect(line.toLowerCase()).toContain('prime');
  });

  it('carries the backlog band on a fresh session — stale AFK stories and draft intents', () => {
    const line = renderSessionStart('llm-wiki', 'startup', {}, { stale: 2, draftIntents: 3 });

    expect(line).toContain('2 stale');
    expect(line).toContain('3 draft intent');
  });

  it('stays lean when the band is empty', () => {
    const line = renderSessionStart('llm-wiki', 'startup', {}, { stale: 0, draftIntents: 0 });

    expect(line).not.toContain('stale');
    expect(line).not.toContain('intent');
  });

  it('re-orients after compaction with the capture instruction', () => {
    const line = renderSessionStart('llm-wiki', 'compact');

    expect(line).toContain('"llm-wiki"');
    expect(line.toLowerCase()).toContain('compact');
    expect(line.toLowerCase()).toContain('primer');
  });

  it('treats resume, clear, fork, and absent sources as fresh orientation', () => {
    for (const source of ['resume', 'clear', 'fork', undefined]) {
      expect(renderSessionStart('s', source).toLowerCase()).toContain('prime');
    }
  });

  it('honors builtin_hooks prose per id while the scope binding stays engine-owned', () => {
    const orient = renderSessionStart('s', 'startup', { orient: { text: 'Custom orient.' } });
    const reorient = renderSessionStart('s', 'compact', { reorient: { text: 'Custom reorient.' } });

    expect(orient).toContain('Custom orient.');
    expect(orient).toContain('"s"');
    expect(reorient).toContain('Custom reorient.');
    expect(reorient).toContain('"s"');
    expect(renderSessionStart('s', 'startup', { reorient: { text: 'X.' } })).not.toContain('X.');
  });
});

describe('vaultPathTouched', () => {
  it('matches absolute paths under the vault root, including the root itself', () => {
    expect(vaultPathTouched({ file_path: '/v/notes/x.md' }, '/v')).toBe(true);
    expect(vaultPathTouched({ file_path: '/v' }, '/v')).toBe(true);
    expect(vaultPathTouched({ file_path: '/elsewhere/notes/x.md' }, '/v')).toBe(false);
  });

  it('does not treat a sibling directory prefix as inside the vault', () => {
    expect(vaultPathTouched({ file_path: '/v-other/x.md' }, '/v')).toBe(false);
  });

  it('resolves relative candidates against the event cwd', () => {
    expect(vaultPathTouched({ file_path: 'notes/x.md' }, '/v', '/v')).toBe(true);
    expect(vaultPathTouched({ file_path: 'notes/x.md' }, '/v', '/repo')).toBe(false);
  });

  it('ignores tool input without path fields or path-bearing command', () => {
    expect(vaultPathTouched({ description: 'mentions notes but no path' }, '/v')).toBe(false);
    expect(vaultPathTouched(undefined, '/v')).toBe(false);
  });

  describe('command strings', () => {
    it('detects a shell deletion of a vault page', () => {
      expect(vaultPathTouched({ command: 'rm notes/x.md' }, '/v', '/v')).toBe(true);
    });

    it('detects absolute vault paths regardless of cwd', () => {
      expect(vaultPathTouched({ command: 'rm /v/notes/x.md' }, '/v')).toBe(true);
      expect(vaultPathTouched({ command: 'mv /v/notes/a.md /elsewhere/' }, '/v', '/repo')).toBe(
        true
      );
    });

    it('keeps quoted paths with spaces as one candidate', () => {
      expect(vaultPathTouched({ command: 'rm "notes/my note.md"' }, '/v', '/v')).toBe(true);
      expect(vaultPathTouched({ command: "rm 'notes/my note.md'" }, '/v', '/v')).toBe(true);
    });

    it('splits candidates off attached shell separators', () => {
      expect(vaultPathTouched({ command: 'echo hi >notes/x.md' }, '/v', '/v')).toBe(true);
      expect(vaultPathTouched({ command: 'true;rm notes/x.md' }, '/v', '/v')).toBe(true);
    });

    it('treats bare vault-content filenames as candidates', () => {
      expect(vaultPathTouched({ command: "sed -i '' vault.yaml" }, '/v', '/v')).toBe(true);
    });

    it('treats glob, dot, and variable tokens as candidates inside the vault', () => {
      expect(vaultPathTouched({ command: 'rm *' }, '/v', '/v')).toBe(true);
      expect(vaultPathTouched({ command: 'rm -rf .' }, '/v', '/v')).toBe(true);
      expect(vaultPathTouched({ command: 'rm "$F"' }, '/v', '/v')).toBe(true);
      expect(vaultPathTouched({ command: 'rm *' }, '/v', '/repo')).toBe(false);
      expect(vaultPathTouched({ command: 'rm "$F"' }, '/v', '/repo')).toBe(false);
    });

    it('stays quiet for commands without path-like tokens, even inside the vault', () => {
      expect(vaultPathTouched({ command: 'git status' }, '/v', '/v')).toBe(false);
      expect(vaultPathTouched({ command: 'ls -la' }, '/v', '/v')).toBe(false);
    });

    it('stays quiet for paths outside the vault', () => {
      expect(vaultPathTouched({ command: 'rm /elsewhere/x.md' }, '/v', '/repo')).toBe(false);
      expect(vaultPathTouched({ command: 'rm notes/x.md' }, '/v', '/repo')).toBe(false);
      expect(vaultPathTouched({ command: 'rm /v-other/x.md' }, '/v')).toBe(false);
    });
  });

  it('reads paths out of an apply_patch envelope', () => {
    const patch = '*** Begin Patch\n*** Update File: /v/notes/x.md\n@@\n-a\n+b\n*** End Patch';

    expect(vaultPathTouched({ patch }, '/v')).toBe(true);
    expect(vaultPathTouched(patch, '/v')).toBe(true);
    expect(vaultPathTouched({ input: patch.replace('/v/', '/elsewhere/') }, '/v')).toBe(false);
  });

  it('resolves relative apply_patch paths against the event cwd', () => {
    const patch = '*** Begin Patch\n*** Add File: notes/new.md\n+body\n*** End Patch';

    expect(vaultPathTouched({ patch }, '/v', '/v')).toBe(true);
    expect(vaultPathTouched({ patch }, '/v', '/repo')).toBe(false);
  });
});

describe('renderPosttool', () => {
  const error: Finding = {
    path: 'notes/x.md',
    rule: 'kind-vocabulary',
    severity: 'error',
    message: 'unknown kind "bogus"'
  };
  const warning: Finding = {
    path: 'notes/y.md',
    rule: 'tag-alias',
    severity: 'warning',
    message: 'alias tag'
  };

  it('renders nothing on the quiet path', () => {
    expect(renderPosttool([], true, 'claude')).toBeNull();
    expect(renderPosttool([], true, 'neutral')).toBeNull();
  });

  it('maps errors to a decision block carrying the fix list (claude)', () => {
    const out = JSON.parse(renderPosttool([error, warning], false, 'claude') as string) as {
      decision: string;
      reason: string;
    };

    expect(out.decision).toBe('block');
    expect(out.reason).toContain('kind-vocabulary');
    expect(out.reason).toContain('tag-alias');
  });

  it('surfaces warnings as context without a decision (claude)', () => {
    const out = JSON.parse(renderPosttool([warning], true, 'claude') as string) as {
      decision?: string;
      hookSpecificOutput: Record<string, string>;
    };

    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('tag-alias');
  });

  it('reports a failed sync on an otherwise clean vault (claude)', () => {
    const out = JSON.parse(renderPosttool([], false, 'claude') as string) as {
      hookSpecificOutput: Record<string, string>;
    };

    expect(out.hookSpecificOutput.additionalContext).toContain('kmd sync failed');
  });

  it('emits findings and sync status as JSON (neutral)', () => {
    const out = JSON.parse(renderPosttool([error], false, 'neutral') as string) as {
      findings: Finding[];
      synced: boolean;
    };

    expect(out.findings).toEqual([error]);
    expect(out.synced).toBe(false);
  });
});

describe('kiroIdePromptEvent', () => {
  const original = process.env.USER_PROMPT;

  afterEach(() => {
    if (original === undefined) delete process.env.USER_PROMPT;
    else process.env.USER_PROMPT = original;
  });

  it('returns null when $USER_PROMPT is unset or empty', () => {
    delete process.env.USER_PROMPT;
    expect(kiroIdePromptEvent()).toBeNull();

    process.env.USER_PROMPT = '';
    expect(kiroIdePromptEvent()).toBeNull();
  });

  it('builds the event from $USER_PROMPT and the process cwd', () => {
    process.env.USER_PROMPT = 'cut the release';

    expect(kiroIdePromptEvent(0)).toEqual({
      session_id: `kiro:${process.cwd()}:0`,
      prompt: 'cut the release',
      cwd: process.cwd()
    });
  });

  it('keys dedup to a 30-minute bucket', () => {
    process.env.USER_PROMPT = 'release';
    const bucket = 30 * 60 * 1000;
    const start = 1000 * bucket;
    const keyAt = (now: number) => kiroIdePromptEvent(now)?.session_id;

    expect(keyAt(start)).toBe(keyAt(start + bucket - 1));
    expect(keyAt(start)).not.toBe(keyAt(start + bucket));
  });
});

describe('pretool files matching over apply_patch envelopes', () => {
  it('files globs match the envelope paths, as at posttool', () => {
    const trigger: Trigger = {
      id: 'tag-script',
      on: 'pretool',
      enforce: 'block',
      files: ['.logs/commits/*.md'],
      args_match: 'git tag',
      reason: 'no'
    };
    const envelope = {
      command: '*** Begin Patch\n*** Add File: .logs/commits/2026.md\n+git tag v1\n*** End Patch'
    };

    expect(matchPretoolTriggers('apply_patch', envelope, [trigger])).toHaveLength(1);
    expect(
      matchPretoolTriggers(
        'apply_patch',
        { command: '*** Begin Patch\n*** Add File: src/x.ts\n+git tag\n*** End Patch' },
        [trigger]
      )
    ).toHaveLength(0);
  });
});

describe('parseStopEvent', () => {
  it('accepts the minimal event and carries the optional fields', () => {
    expect(parseStopEvent('{"session_id":"s1"}')).toEqual({ session_id: 's1' });
    expect(
      parseStopEvent('{"session_id":"s1","cwd":"/repo","stop_hook_active":true,"extra":1}')
    ).toEqual({ session_id: 's1', cwd: '/repo', stop_hook_active: true });
  });

  it('rejects malformed payloads', () => {
    expect(parseStopEvent('not json')).toBeNull();
    expect(parseStopEvent('{"cwd":"/repo"}')).toBeNull();
    expect(parseStopEvent('{"session_id":42}')).toBeNull();
  });
});

describe('renderStop', () => {
  const error: Finding = {
    path: 'notes/x.md',
    rule: 'kind-vocabulary',
    severity: 'error',
    message: 'unknown kind "bogus"'
  };
  const warning: Finding = {
    path: 'notes/y.md',
    rule: 'tag-alias',
    severity: 'warning',
    message: 'alias tag'
  };

  it('renders nothing without errors — warnings never block a handoff', () => {
    expect(renderStop([])).toBeNull();
    expect(renderStop([warning])).toBeNull();
  });

  it('blocks with the error lines only', () => {
    const out = JSON.parse(renderStop([error, warning]) as string) as {
      decision: string;
      reason: string;
    };

    expect(out.decision).toBe('block');
    expect(out.reason).toContain('kind-vocabulary');
    expect(out.reason).not.toContain('tag-alias');
  });

  it('a configured reason replaces the preamble, never the error lines', () => {
    const out = JSON.parse(renderStop([error], 'not done yet') as string) as { reason: string };

    expect(out.reason).toMatch(/^not done yet:/);
    expect(out.reason).toContain('kind-vocabulary');
  });
});

describe('builtin_hooks message overrides (resync)', () => {
  const error: Finding = {
    path: 'notes/x.md',
    rule: 'kind-vocabulary',
    severity: 'error',
    message: 'unknown kind "bogus"'
  };

  it('a configured reason replaces the errors preamble only', () => {
    const out = JSON.parse(
      renderPosttool([error], false, 'claude', { reason: 'Edit landed; sync held' }) as string
    ) as { reason: string };

    expect(out.reason).toMatch(/^Edit landed; sync held:/);
    expect(out.reason).toContain('kind-vocabulary');
  });

  it('a configured text replaces the sync-failed note', () => {
    const out = JSON.parse(
      renderPosttool([], false, 'claude', { text: 'index stale' }) as string
    ) as {
      hookSpecificOutput: Record<string, string>;
    };

    expect(out.hookSpecificOutput.additionalContext).toContain('index stale');
  });

  it('defaults state the gate model when unconfigured', () => {
    const out = JSON.parse(renderPosttool([error], false, 'claude') as string) as {
      reason: string;
    };

    expect(out.reason).toMatch(/^Edit landed; the index sync is held/);
  });
});

describe('dedup policy', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kmd-dedup-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('never-policy fires on every match and spends no state', () => {
    const match = [{ id: 'nudge', dedup: 'never' as const }];

    expect(dedupeMatches(stateDir, 's1', match)).toHaveLength(1);
    expect(dedupeMatches(stateDir, 's1', match)).toHaveLength(1);
    expect(dedupeMatches(stateDir, 's1', [{ id: 'nudge' }])).toHaveLength(1);
  });

  it('bucket-policy holds within a bucket and re-fires across the boundary', () => {
    const match = [{ id: 'nudge', dedup: { minutes: 30 } }];
    const bucket = 30 * 60_000;

    expect(dedupeMatches(stateDir, 's1', match, 0)).toHaveLength(1);
    expect(dedupeMatches(stateDir, 's1', match, bucket - 1)).toHaveLength(0);
    expect(dedupeMatches(stateDir, 's1', match, bucket)).toHaveLength(1);
  });

  it('absent policy keeps once-per-session', () => {
    const match = [{ id: 'nudge' }];

    expect(dedupeMatches(stateDir, 's1', match)).toHaveLength(1);
    expect(dedupeMatches(stateDir, 's1', match)).toHaveLength(0);
  });
});

describe('stop gate dedup', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kmd-stop-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('blocks once per session, then passes silently', () => {
    const gate = [{ id: 'handoff-gate' }];

    expect(dedupeMatches(stateDir, 'stop-s1', gate)).toHaveLength(1);
    expect(dedupeMatches(stateDir, 'stop-s1', gate)).toHaveLength(0);
    expect(dedupeMatches(stateDir, 'stop-s2', gate)).toHaveLength(1);
  });
});

describe('renderSessionStart: vault behind the starter', () => {
  it('names the delta and the command when the vault is behind', () => {
    const line = renderSessionStart(
      'llm-wiki',
      'startup',
      {},
      { stale: 0, draftIntents: 0 },
      '3 kinds, 1 template'
    );

    expect(line).toContain('Vault behind the starter: 3 kinds, 1 template — kmd init --upgrade.');
  });

  it('is silent when the vault is current', () => {
    const line = renderSessionStart('llm-wiki', 'startup', {}, { stale: 0, draftIntents: 0 });

    expect(line).not.toContain('behind');
  });
});

/** Shape lock for intent-coco-session-start-stdout-not-in-context. */
describe('session-start stdout is the JSON context envelope', () => {
  it('wraps the orientation line in hookSpecificOutput.additionalContext for SessionStart', () => {
    const line = renderSessionStart('llm-wiki', 'startup');

    const parsed = JSON.parse(sessionStartStdout(line)) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };

    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(line);
  });

  it('is one line, so a harness that reads stdout line by line still parses it', () => {
    const out = sessionStartStdout(renderSessionStart('llm-wiki', 'compact'));

    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out.trim().startsWith('{')).toBe(true);
    expect(out.trim().endsWith('}')).toBe(true);
  });
});
