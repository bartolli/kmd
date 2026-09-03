import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Hook wiring is per-flavor chrome; claude and codex invoke the byte-shared
// wrapper with --default-root so the engine chain (event cwd as project
// signal) decides the vault. A bare vault-root positional in either file
// would pin rank 1 and disable project awareness. Coco is asserted below —
// it carries no configured vault to pass, so it passes no root at all.
const CLAUDE_HOOKS = fileURLToPath(
  new URL('../../../plugins/claude/wiki-sdd/hooks/hooks.json', import.meta.url)
);
const CODEX_HOOKS = fileURLToPath(
  new URL('../../../plugins/codex/wiki-sdd/hooks/hooks.json', import.meta.url)
);
const COCO_MANIFEST = fileURLToPath(
  new URL('../../../.cortex-plugin/plugin.json', import.meta.url)
);
const COCO_ROOT = fileURLToPath(new URL('../../../plugins/coco/wiki-sdd', import.meta.url));
const COCO_WRAPPER = fileURLToPath(
  new URL('../../../plugins/coco/wiki-sdd/hooks/run-kmd-hook.mjs', import.meta.url)
);
const SHARED_WRAPPER = fileURLToPath(
  new URL('../../../plugins/src/wiki-sdd/hooks/run-kmd-hook.mjs', import.meta.url)
);

describe('hook wiring chrome', () => {
  it('both flavors invoke the wrapper with --default-root', () => {
    for (const path of [CLAUDE_HOOKS, CODEX_HOOKS]) {
      const raw = readFileSync(path, 'utf8');
      expect(raw).toContain('run-kmd-hook.mjs');
      expect(raw).not.toContain('claude-project-override.mjs');
      const events = raw.match(/hook",?\s|hook (session-start|prompt|pretool|posttool|stop)/g);
      expect(events).not.toBeNull();
      expect(raw.match(/--default-root/g)?.length).toBe(5);
    }
  });

  it('claude entries carry no positional between the event and --default-root', () => {
    const parsed = JSON.parse(readFileSync(CLAUDE_HOOKS, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ args: string[] }> }>>;
    };
    for (const entries of Object.values(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          const eventIndex = hook.args.indexOf('hook') + 1;
          expect(hook.args[eventIndex + 1]).toBe('--default-root');
        }
      }
    }
  });
});

// CoCo resolves one manifest at the repo root (.cortex-plugin wins over
// .claude-plugin, so the Claude marketplace file stays invisible to it);
// hooks and mcpServers ride inline in that manifest, the flavor dir holds
// only the components it points at. CoCo carries no user-config prompt, so
// neither surface has a vault root to pass — both leave kmd's chain to
// resolve. What the chrome must get right is harness-shaped: hooks are
// shell strings (CoCo expands ${…_PLUGIN_ROOT} in `command` and nothing
// else, then runs it under $SHELL -c) anchored at the repo root, and
// matchers are tested against lowercase runtime tool ids.
describe('coco hook wiring chrome (inline in the root manifest)', () => {
  const raw = readFileSync(COCO_MANIFEST, 'utf8');
  const parsed = JSON.parse(raw) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };

  it('registers the wrapper on all five events as repo-root-anchored shell strings', () => {
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit'
    ]);
    for (const entries of Object.values(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe('command');
          expect(hook.args).toBeUndefined();
          expect(String(hook.command)).toContain(
            `\${CORTEX_PLUGIN_ROOT}/plugins/coco/wiki-sdd/hooks/run-kmd-hook.mjs`
          );
        }
      }
    }
  });

  it('passes no vault root on either surface — the chain resolves', () => {
    expect(raw).not.toContain('--default-root');
    expect(raw).not.toMatch(/hook (session-start|prompt|pretool|posttool|stop) [^-]/);
    const wiki = parsed.mcpServers.wiki;
    expect(wiki?.command).toBe('kmd');
    expect(wiki?.args).toEqual(['mcp']);
    // The plugin env is scrubbed to HOME/LOGNAME/PATH/SHELL/TERM/USER, so the
    // two vault signals only reach the server if the entry forwards them.
    expect(wiki?.env.WIKI_VAULT).toBe(`\${WIKI_VAULT:-}`);
    expect(wiki?.env.KMD_PROJECT_DIR).toBe(`\${KMD_PROJECT_DIR:-}`);
  });

  it('matches lowercase tool ids — a capitalized matcher silently matches nothing', () => {
    const matcher = parsed.hooks.PostToolUse?.[0]?.matcher;
    expect(matcher).toBe('edit|write|apply_patch|bash');
  });

  it('ships its own resolver with no npx path anywhere in the bundle', () => {
    const wrapper = readFileSync(COCO_WRAPPER, 'utf8');
    const shared = readFileSync(SHARED_WRAPPER, 'utf8');
    // Not the token — the token appears in the file's own comment saying why
    // it is absent. What must not exist is the invocation: nothing here may
    // reach a registry. Spawning the local kmd is not that reach, and the
    // bundle already depends on it — the manifest starts the MCP server as
    // `kmd mcp` through the same shim — so the ban is on the npx target, not
    // on child_process itself. A shim install (pnpm, Volta) is not importable,
    // and refusing to spawn it is what silently turned the gates off.
    expect(wrapper).not.toMatch(/['"]npx/);
    // The shared wrapper does spawn npx — proving these are not the same file
    // is the point: byte-copying it into coco would reintroduce the fallback.
    expect(shared).toMatch(/spawn\('npx'/);
    expect(wrapper).not.toBe(shared);
    // Degrading open is the contract: exit 2 on UserPromptSubmit blocks the
    // user's prompt, so a missing prerequisite must still exit 0.
    expect(wrapper).toContain('process.exit(0)');
    expect(wrapper).not.toMatch(/process\.exit\([^0]/);
  });

  it('never registers the probe flags, which disable enforcement', () => {
    expect(raw).not.toContain('--explain');
    expect(raw).not.toContain('--dry-run');
  });
});

// The whole point of a separate coco flavor for the enterprise case: `npx` is
// blocked there, so no file CoCo executes or shows the user may invoke it.
// Prose that says "prefer kmd over npx" is fine; a command line is not.
describe('coco bundle is npx-free', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]
    );
  }

  it('invokes npx from no file in the bundle', () => {
    const offenders = [...walk(COCO_ROOT), COCO_MANIFEST].filter((f) => {
      const text = readFileSync(f, 'utf8');
      // a JSON command field, a shell word, or a spawn argument
      return /"command":\s*"npx"|\bnpx\s+-y\b|['"]npx['"]/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

/** The coco route for orientation: Cortex runs SessionStart before the agent
 * connects, so the line is held for the first prompt (spec-gate-model,
 * Harness delivery). Only SessionStart carries the flag. */
describe('cortex manifest orientation deferral', () => {
  it('passes --defer-orientation on SessionStart alone', () => {
    const raw = readFileSync(COCO_MANIFEST, 'utf8');
    const manifest = JSON.parse(raw) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const commands = (event: string) =>
      manifest.hooks[event]?.flatMap((m) => m.hooks.map((h) => h.command)) ?? [];

    expect(
      commands('SessionStart').every((c) => c.includes('hook session-start --defer-orientation'))
    ).toBe(true);
    for (const event of Object.keys(manifest.hooks).filter((e) => e !== 'SessionStart')) {
      expect(
        commands(event).some((c) => c.includes('--defer-orientation')),
        event
      ).toBe(false);
    }
  });
});
