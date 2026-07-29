import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadManifest } from './manifest.js';

const MANIFEST = `
sourceRoot: plugins/src/wiki-sdd
flavors:
  claude:
    dest: plugins/claude/wiki-sdd
    dialect: identity
  codex:
    dest: plugins/codex/wiki-sdd
    dialect:
      kind: codex
      slashAliases: [dense]
      replacements:
        - ["Read \`CLAUDE.md\` or \`AGENTS.md\`.", "Read \`AGENTS.md\`."]
  kiro:
    dest: plugins/kiro/wiki-sdd
    dialect:
      kind: kiro
      replacements: []
shared:
  exact:
    - skills/wiki/references/vault-yaml.md
    - path: hooks/run-kmd-hook.mjs
      flavors: [claude, codex]
  rendered:
    - skills/wiki/SKILL.md
lintAllow:
  - "\`CLAUDE.md\` or \`AGENTS.md\` (step 6)"
chrome:
  claude: [README.md]
retired:
  - plugins/kiro/wiki-sdd/POWER.md
`;

describe('loadManifest', () => {
  it('parses flavors, dialects, and normalizes exact entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
    const p = join(dir, 'render-manifest.yaml');
    writeFileSync(p, MANIFEST);
    const m = loadManifest(p);
    expect(m.sourceRoot).toBe('plugins/src/wiki-sdd');
    expect(m.flavors.claude?.dialect).toEqual({ kind: 'identity' });
    expect(m.flavors.codex?.dialect).toMatchObject({ kind: 'codex', slashAliases: ['dense'] });
    expect(m.shared.exact).toEqual([
      { path: 'skills/wiki/references/vault-yaml.md' },
      { path: 'hooks/run-kmd-hook.mjs', flavors: ['claude', 'codex'] }
    ]);
    expect(m.shared.rendered).toEqual(['skills/wiki/SKILL.md']);
    expect(m.lintAllow).toEqual(['`CLAUDE.md` or `AGENTS.md` (step 6)']);
  });

  it('rejects an unknown dialect kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
    const p = join(dir, 'render-manifest.yaml');
    writeFileSync(p, MANIFEST.replace('kind: kiro', 'kind: mystery'));
    expect(() => loadManifest(p)).toThrow();
  });
});
