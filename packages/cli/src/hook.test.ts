import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Trigger, VaultConfig } from './config.js';
import type { PretoolMatch } from './hook.js';
import {
  dedupeMatches,
  dedupePretoolMatches,
  effectiveTriggers,
  evaluateMatches,
  kiroIdePromptEvent,
  loadTriggerFile,
  matchPretoolTriggers,
  matchPromptTriggers,
  parsePretoolEvent,
  parsePromptEvent,
  renderPosttool,
  renderPretool,
  resolveScope,
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

  it('ignores tool input without path fields', () => {
    expect(vaultPathTouched({ command: 'echo /v/notes/x.md' }, '/v')).toBe(false);
    expect(vaultPathTouched(undefined, '/v')).toBe(false);
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
