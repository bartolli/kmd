import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Hook wiring is per-flavor chrome; both flavors invoke the byte-shared
// wrapper with --default-root so the engine chain (event cwd as project
// signal) decides the vault. A bare vault-root positional in either file
// would pin rank 1 and disable project awareness.
const CLAUDE_HOOKS = fileURLToPath(
  new URL('../../../plugins/claude/wiki-sdd/hooks/hooks.json', import.meta.url)
);
const CODEX_HOOKS = fileURLToPath(
  new URL('../../../plugins/codex/wiki-sdd/hooks/hooks.json', import.meta.url)
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
