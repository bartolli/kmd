import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RenderManifest } from './render.js';
import { render } from './render.js';

const SKILL = `---
name: foo
description: Use /foo when the agent needs it.
---

Run \`/foo\` when the agent asks. The token stays a path in skills/foo/SKILL.md.
`;

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

let root: string;

function write(rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function manifest(): RenderManifest {
  return {
    sourceRoot: 'src/wiki-sdd',
    flavors: {
      claude: { dest: 'plugins/claude/wiki-sdd', dialect: { kind: 'claude' } },
      codex: {
        dest: 'plugins/codex/wiki-sdd',
        dialect: { kind: 'codex', slashAliases: [], replacements: [] }
      },
      coco: {
        dest: 'plugins/coco/wiki-sdd',
        dialect: { kind: 'coco', slashAliases: [], replacements: [] }
      }
    },
    shared: { exact: [], rendered: ['skills/foo/SKILL.md'] }
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'render-'));
  write('src/wiki-sdd/skills/foo/SKILL.md', SKILL);
  write(
    'src/wiki-sdd/plugin.json',
    JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'wiki-sdd', version: '1.2.3' })
  );
  write(
    'src/wiki-sdd/mcp.json',
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        wiki: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/x.mjs', 'mcp'] }
      }
    })
  );
});

describe('render', () => {
  it('propagates a shared edit into every flavor with no hand mirroring', () => {
    const result = render(root, manifest(), 'write');
    expect(result.problems).toEqual([]);

    expect(read('plugins/claude/wiki-sdd/skills/foo/SKILL.md')).toBe(SKILL);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `$foo` when the agent asks. The token stays a path in skills/foo/SKILL.md.'
    );
    expect(read('plugins/coco/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Run `$foo` when the agent asks.'
    );

    const again = render(root, manifest(), 'write');
    expect(again.problems).toEqual([]);
    expect(read('plugins/claude/wiki-sdd/skills/foo/SKILL.md')).toBe(SKILL);
  });

  it('never touches per-harness chrome', () => {
    write('plugins/codex/wiki-sdd/hooks/hooks.json', 'codex-specific');
    write('plugins/codex/wiki-sdd/README.md', 'codex readme');
    render(root, manifest(), 'write');
    expect(read('plugins/codex/wiki-sdd/hooks/hooks.json')).toBe('codex-specific');
    expect(read('plugins/codex/wiki-sdd/README.md')).toBe('codex readme');
  });

  it('removes stale files from a dest skills tree — adapters are build output', () => {
    write('plugins/codex/wiki-sdd/skills/stale/SKILL.md', 'gone after render');
    render(root, manifest(), 'write');
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/skills/stale'))).toBe(false);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain('Run `$foo`');
  });

  it('fails the render when CLAUDE.md survives a dialect transform, writing nothing', () => {
    write('src/wiki-sdd/skills/foo/SKILL.md', 'Edit `CLAUDE.md` directly.\n');
    const result = render(root, manifest(), 'write');
    expect(result.problems.some((p) => p.includes('CLAUDE.md') && p.includes('foo/SKILL.md'))).toBe(
      true
    );
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });

  it('lets an allowed CLAUDE.md reach the coco flavor — CoCo reads it as project instructions', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\n---\n\nEdit `CLAUDE.md` directly.\n'
    );
    const cocoOnly: RenderManifest = {
      sourceRoot: 'src/wiki-sdd',
      flavors: {
        coco: {
          dest: 'plugins/coco/wiki-sdd',
          dialect: { kind: 'coco', slashAliases: [], replacements: [] }
        }
      },
      shared: { exact: [], rendered: ['skills/foo/SKILL.md'] },
      lintAllow: ['Edit `CLAUDE.md` directly.']
    };
    const result = render(root, cocoOnly, 'write');
    expect(result.problems).toEqual([]);
    expect(read('plugins/coco/wiki-sdd/skills/foo/SKILL.md')).toContain(
      'Edit `CLAUDE.md` directly.'
    );
  });

  it('check mode passes a fresh render and reports tampering and stale files', () => {
    render(root, manifest(), 'write');
    expect(render(root, manifest(), 'check').mismatches).toEqual([]);

    write('plugins/codex/wiki-sdd/skills/foo/SKILL.md', 'hand edit');
    write('plugins/claude/wiki-sdd/skills/rogue/SKILL.md', 'unmanaged');
    const result = render(root, manifest(), 'check');
    expect(result.mismatches.some((m) => m.includes('codex') && m.includes('foo/SKILL.md'))).toBe(
      true
    );
    expect(result.mismatches.some((m) => m.includes('claude') && m.includes('rogue'))).toBe(true);
  });

  it('lets lintAllow literals survive a dialect transform while unlisted CLAUDE.md still fails', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\n---\n\n| Claude Code | `CLAUDE.md` or `AGENTS.md` (step 6) |\n'
    );
    const m = manifest();
    m.lintAllow = ['| Claude Code | `CLAUDE.md` or `AGENTS.md` (step 6) |'];
    expect(render(root, m, 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(
      '`CLAUDE.md` or `AGENTS.md` (step 6)'
    );

    write('src/wiki-sdd/skills/foo/SKILL.md', 'Also edit `CLAUDE.md` directly.\n');
    const result = render(root, m, 'write');
    expect(result.problems.some((p) => p.includes('CLAUDE.md'))).toBe(true);
  });

  it('stamps metadata.version into rendered SKILL.md files from the version source', () => {
    write('plugins/claude/wiki-sdd/.claude-plugin/plugin.json', '{"version": "0.2.0"}');
    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'wiki-sdd', version: '0.2.0' })
    );
    const m = manifest();
    m.versionSource = 'plugins/claude/wiki-sdd/.claude-plugin/plugin.json';
    expect(render(root, m, 'write').problems).toEqual([]);

    for (const flavor of ['claude', 'codex', 'coco']) {
      const out = read(`plugins/${flavor}/wiki-sdd/skills/foo/SKILL.md`);
      expect(out).toMatch(/metadata:\n {2}version: "0\.2\.0"\n---/);
    }
    expect(render(root, m, 'check').mismatches).toEqual([]);
  });

  it('fails the render when a source SKILL.md declares its own metadata block', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\nmetadata:\n  version: "9.9.9"\n---\n\nBody.\n'
    );
    write('plugins/claude/wiki-sdd/.claude-plugin/plugin.json', '{"version": "0.2.0"}');
    const m = manifest();
    m.versionSource = 'plugins/claude/wiki-sdd/.claude-plugin/plugin.json';
    const result = render(root, m, 'write');
    expect(result.problems.some((p) => p.includes('metadata'))).toBe(true);
  });

  it('writes flavor-restricted exact files only into their listed flavors', () => {
    write('src/wiki-sdd/scripts/run-kmd.mjs', 'launcher bytes');
    const m = manifest();
    m.shared.exact = [{ path: 'scripts/run-kmd.mjs', flavors: ['claude', 'codex'] }];
    render(root, m, 'write');
    expect(read('plugins/claude/wiki-sdd/scripts/run-kmd.mjs')).toBe('launcher bytes');
    expect(read('plugins/codex/wiki-sdd/scripts/run-kmd.mjs')).toBe('launcher bytes');
    expect(existsSync(join(root, 'plugins/coco/wiki-sdd/scripts/run-kmd.mjs'))).toBe(false);
  });
});

describe('the source package', () => {
  it('stops the render on an invalid source manifest, writing nothing', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'Bad Name' }));
    const result = render(root, manifest(), 'write');
    expect(result.problems).toEqual([expect.stringMatching(/^plugin\.json: \/name /)]);
    expect(existsSync(join(root, 'plugins/claude/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });
});

describe('one version', () => {
  it('fails when the root manifest version differs from versionSource', () => {
    write(
      'plugins/claude/wiki-sdd/.claude-plugin/plugin.json',
      JSON.stringify({ version: '0.20.0' })
    );
    const m = {
      ...manifest(),
      versionSource: 'plugins/claude/wiki-sdd/.claude-plugin/plugin.json'
    };
    const result = render(root, m, 'check');
    expect(result.problems).toEqual([
      'plugin.json: version 1.2.3 differs from versionSource 0.20.0 — one version ships everywhere'
    ]);

    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'wiki-sdd', version: '0.20.0' })
    );
    expect(render(root, m, 'write').problems).toEqual([]);
  });
});

describe('harness-neutral source', () => {
  it('stops the render on a bare harness name in a skill body, writing nothing', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\n---\n\nRun `/foo` when Claude asks; Kiro reads `CLAUDE.md`.\n'
    );
    const result = render(root, manifest(), 'write');
    const named = result.problems.filter((p) => p.includes('harness name'));
    expect(named).toEqual([
      expect.stringMatching(/^skills\/foo\/SKILL\.md: harness name `Claude` /),
      expect.stringMatching(/^skills\/foo\/SKILL\.md: harness name `Kiro` /),
      expect.stringMatching(/^skills\/foo\/SKILL\.md: harness name `CLAUDE\.md` /)
    ]);
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });
});

/** Shape lock for intent-codex-manifest-default-prompt-names-retired-skills. */
describe('skill tokens name Package skills', () => {
  it('stops the render on a `$name` in the manifest or an extension dir, and a `/name` in a skill body, that names no skill', () => {
    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({
        $schema: PLUGIN_SCHEMA,
        name: 'wiki-sdd',
        version: '1.2.3',
        extensions: {
          'com.openai.codex': {
            interface: {
              displayName: 'Wiki SDD',
              defaultPrompt: ['Use $foo to start.', 'Use $grill-with-docs to refine this.']
            }
          }
        }
      })
    );
    write('src/wiki-sdd/com.snowflake.cortex/activation.md', 'Ask for `$foo` or `$to-prd`.\n');
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      '---\nname: foo\ndescription: Ok.\n---\n\nRun `/foo`, then `/bar`; `/dense` is an alias.\n'
    );
    const m = manifest();
    m.flavors.codex = {
      dest: 'plugins/codex/wiki-sdd',
      dialect: { kind: 'codex', slashAliases: ['dense'], replacements: [] }
    };
    const tokens = render(root, m, 'write').problems.filter((p) => p.includes('skill token'));
    expect(tokens).toEqual([
      expect.stringMatching(/^skills\/foo\/SKILL\.md: skill token `\/bar` /),
      expect.stringMatching(/^plugin\.json: skill token `\$grill-with-docs` /),
      expect.stringMatching(/^com\.snowflake\.cortex\/activation\.md: skill token `\$to-prd` /)
    ]);
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/.codex-plugin/plugin.json'))).toBe(false);
  });
});

describe('allowed harness-placement section', () => {
  const TABLE =
    '| | Claude Code | Codex | CoCo | Kiro |\n| Project instructions | `CLAUDE.md` | `AGENTS.md` | `CORTEX.md` | `AGENTS.md` |\n';

  it('exempts one section by heading from both lints, and nothing outside it', () => {
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: Ok.\n---\n\n## Mental model\n\nThe agent reads the project instructions.\n\n### Harness placement\n\n${TABLE}\n### Gate hooks\n\nGates read the project from each event.\n`
    );
    const m = manifest();
    m.lintAllow = [{ section: '### Harness placement' }];
    expect(render(root, m, 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/skills/foo/SKILL.md')).toContain(TABLE);

    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: Ok.\n---\n\n### Harness placement\n\n${TABLE}\n### Gate hooks\n\nKiro reads \`CLAUDE.md\` here.\n`
    );
    const named = render(root, m, 'write').problems.filter((p) => p.includes('harness name'));
    expect(named).toEqual([
      expect.stringMatching(/harness name `Kiro` /),
      expect.stringMatching(/harness name `CLAUDE\.md` /)
    ]);
  });
});

describe('Agent Skills caps on the source', () => {
  it('fails the render on any flavor set when a source skill breaks the name or description limits', () => {
    const claudeOnly: RenderManifest = {
      sourceRoot: 'src/wiki-sdd',
      flavors: { claude: { dest: 'plugins/claude/wiki-sdd', dialect: { kind: 'claude' } } },
      shared: { exact: [], rendered: ['skills/foo/SKILL.md'] }
    };
    write(
      'src/wiki-sdd/skills/foo/SKILL.md',
      `---\nname: foo\ndescription: >\n  ${'x'.repeat(1030)}\n---\n\nBody.\n`
    );
    expect(render(root, claudeOnly, 'write').problems).toEqual([
      expect.stringMatching(
        /^skills\/foo\/SKILL\.md: description is 1030 chars — the Agent Skills cap is 1024/
      )
    ]);

    write('src/wiki-sdd/skills/foo/SKILL.md', '---\nname: other\ndescription: Ok.\n---\n\nBody.\n');
    expect(render(root, claudeOnly, 'write').problems).toEqual([
      expect.stringMatching(/^skills\/foo\/SKILL\.md: name 'other' must match folder 'foo'/)
    ]);
  });
});

describe('claude manifest projection', () => {
  const ROOT_MANIFEST = {
    $schema: PLUGIN_SCHEMA,
    name: 'wiki-sdd',
    version: '1.2.3',
    description: 'Loop.',
    author: { name: 'A. Author' },
    repository: 'https://example.invalid/kmd',
    license: 'MIT',
    keywords: ['wiki', 'sdd'],
    extensions: {
      'com.anthropic.claude-code': {
        $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
        userConfig: { vault_path: { type: 'directory', title: 'Vault path', required: true } }
      }
    }
  };
  const CLAUDE_MANIFEST = `{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "wiki-sdd",
  "version": "1.2.3",
  "description": "Loop.",
  "author": {
    "name": "A. Author"
  },
  "license": "MIT",
  "keywords": [
    "wiki",
    "sdd"
  ],
  "userConfig": {
    "vault_path": {
      "type": "directory",
      "title": "Vault path",
      "required": true
    }
  }
}
`;

  const CODEX_MANIFEST = `{
  "name": "wiki-sdd",
  "version": "1.2.3",
  "description": "Loop.",
  "author": {
    "name": "A. Author"
  },
  "license": "MIT",
  "keywords": [
    "wiki",
    "sdd"
  ],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Wiki SDD"
  }
}
`;

  it('derives .codex-plugin/plugin.json from the root manifest and its codex extension', () => {
    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({
        ...ROOT_MANIFEST,
        extensions: {
          ...ROOT_MANIFEST.extensions,
          'com.openai.codex': { interface: { displayName: 'Wiki SDD' } }
        }
      })
    );
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/.codex-plugin/plugin.json')).toBe(CODEX_MANIFEST);
    write('plugins/codex/wiki-sdd/.codex-plugin/plugin.json', 'hand edit');
    expect(render(root, manifest(), 'check').mismatches).toContain(
      'codex: .codex-plugin/plugin.json: differs from rendered output'
    );
  });

  it('derives the repo-root Cortex manifest: identity from the root, skills by rule, the hook block from the cortex extension', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify(ROOT_MANIFEST));
    write(
      'src/wiki-sdd/com.snowflake.cortex/hooks.json',
      JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'node x.mjs hook stop' }] }] })
    );
    write('.cortex-plugin/plugin.json', JSON.stringify({ name: 'stale', skills: ['./stale'] }));
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    const cortex = JSON.parse(read('.cortex-plugin/plugin.json')) as Record<string, unknown>;
    expect(Object.keys(cortex)).toEqual([
      'name',
      'version',
      'description',
      'author',
      'skills',
      'hooks',
      'mcpServers'
    ]);
    expect(cortex).toMatchObject({
      name: 'wiki-sdd',
      version: '1.2.3',
      description: 'Loop.',
      author: { name: 'A. Author' },
      skills: ['./plugins/coco/wiki-sdd/skills'],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.mjs hook stop' }] }] }
    });
    expect(render(root, manifest(), 'check').mismatches).toEqual([]);
  });

  it("derives the repo-root marketplace entry from the root manifest and the claude extension's marketplace block", () => {
    write(
      'src/wiki-sdd/plugin.json',
      JSON.stringify({
        ...ROOT_MANIFEST,
        extensions: {
          'com.anthropic.claude-code': {
            ...ROOT_MANIFEST.extensions['com.anthropic.claude-code'],
            marketplace: { name: 'kmd', category: 'development', strict: false }
          }
        }
      })
    );
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('.claude-plugin/marketplace.json')).toBe(`{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "kmd",
  "owner": {
    "name": "A. Author"
  },
  "plugins": [
    {
      "name": "wiki-sdd",
      "source": "./plugins/claude/wiki-sdd",
      "description": "Loop.",
      "version": "1.2.3",
      "author": {
        "name": "A. Author"
      },
      "category": "development",
      "strict": false
    }
  ]
}
`);
    write('.claude-plugin/marketplace.json', 'hand edit');
    expect(render(root, manifest(), 'check').mismatches).toEqual([
      expect.stringMatching(
        /^claude: .*\.claude-plugin\/marketplace\.json: differs from rendered output$/
      )
    ]);
  });

  it('one bump: a root version move fails the check for every projection until the render, and nothing else moves', () => {
    const withMarketplace = {
      ...ROOT_MANIFEST,
      extensions: {
        'com.anthropic.claude-code': {
          ...ROOT_MANIFEST.extensions['com.anthropic.claude-code'],
          marketplace: { name: 'kmd', category: 'development', strict: false }
        },
        'com.openai.codex': { interface: { displayName: 'Wiki SDD' } }
      }
    };
    write('src/wiki-sdd/plugin.json', JSON.stringify(withMarketplace));
    const m = { ...manifest(), versionSource: 'src/wiki-sdd/plugin.json' };
    expect(render(root, m, 'write').problems).toEqual([]);
    expect(render(root, m, 'check').mismatches).toEqual([]);

    write('src/wiki-sdd/plugin.json', JSON.stringify({ ...withMarketplace, version: '1.3.0' }));
    const stale = render(root, m, 'check');
    expect(stale.problems).toEqual([]);
    expect(stale.mismatches.map((line) => line.split(': ')[1])).toEqual(
      expect.arrayContaining([
        'skills/foo/SKILL.md',
        '.claude-plugin/plugin.json',
        '../../../.claude-plugin/marketplace.json',
        '.codex-plugin/plugin.json',
        '../../../.cortex-plugin/plugin.json'
      ])
    );

    render(root, m, 'write');
    expect(render(root, m, 'check').mismatches).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/.codex-plugin/plugin.json')).toContain(
      '"version": "1.3.0"'
    );
    expect(read('.claude-plugin/marketplace.json')).toContain('"version": "1.3.0"');
  });

  it('derives .claude-plugin/plugin.json from the root manifest and its claude extension, and checks it', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify(ROOT_MANIFEST));
    write('plugins/claude/wiki-sdd/.claude-plugin/plugin.json', 'hand edit');
    const checked = render(root, manifest(), 'check');
    expect(checked.problems).toEqual([]);
    expect(checked.mismatches).toContain(
      'claude: .claude-plugin/plugin.json: differs from rendered output'
    );

    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('plugins/claude/wiki-sdd/.claude-plugin/plugin.json')).toBe(CLAUDE_MANIFEST);
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/.claude-plugin'))).toBe(false);
  });
});

describe('server registration projections', () => {
  const PORTABLE_MCP = {
    $schema: MCP_SCHEMA,
    mcpServers: {
      wiki: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/run-kmd.mjs', 'mcp'] }
    }
  };
  const ROOT = {
    $schema: PLUGIN_SCHEMA,
    name: 'wiki-sdd',
    version: '1.2.3',
    author: { name: 'A. Author' },
    extensions: {
      'com.anthropic.claude-code': {
        userConfig: { vault_path: { type: 'directory', title: 'Vault path', required: true } }
      }
    }
  };

  it('projects the claude .mcp.json: the Claude root token, the userConfig vault as --default-root, the project dir and log level in env', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify(ROOT));
    write('src/wiki-sdd/mcp.json', JSON.stringify(PORTABLE_MCP));
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('plugins/claude/wiki-sdd/.mcp.json')).toBe(`{
  "mcpServers": {
    "wiki": {
      "type": "stdio",
      "command": "node",
      "args": [
        "\${CLAUDE_PLUGIN_ROOT}/scripts/run-kmd.mjs",
        "mcp",
        "--default-root",
        "\${user_config.vault_path}"
      ],
      "env": {
        "KMD_PROJECT_DIR": "\${CLAUDE_PROJECT_DIR}",
        "LOG_LEVEL": "info"
      }
    }
  }
}
`);
    write('plugins/claude/wiki-sdd/.mcp.json', 'hand edit');
    expect(render(root, manifest(), 'check').mismatches).toContain(
      'claude: .mcp.json: differs from rendered output'
    );
  });

  it('projects the cortex mcpServers block into the repo-root manifest: the source tree under the Cortex root, no vault root, the pass-through env', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify(ROOT));
    write('src/wiki-sdd/mcp.json', JSON.stringify(PORTABLE_MCP));
    write(
      '.cortex-plugin/plugin.json',
      JSON.stringify({
        name: 'stale',
        hooks: { Stop: [] },
        mcpServers: { wiki: { type: 'stdio', command: 'kmd', args: ['mcp'] } }
      })
    );
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    const cortex = JSON.parse(read('.cortex-plugin/plugin.json')) as Record<string, unknown>;
    expect(cortex.mcpServers).toEqual({
      wiki: {
        type: 'stdio',
        command: 'node',
        args: ['${CORTEX_PLUGIN_ROOT}/src/wiki-sdd/scripts/run-kmd.mjs', 'mcp'],
        env: {
          WIKI_VAULT: '${WIKI_VAULT:-}',
          KMD_PROJECT_DIR: '${KMD_PROJECT_DIR:-}',
          LOG_LEVEL: '${WIKI_MCP_LOG_LEVEL:-info}'
        }
      }
    });
  });

  it('projects the codex .mcp.json: the launcher beside the manifest with cwd ".", the env allowlist, no vault root', () => {
    write('src/wiki-sdd/plugin.json', JSON.stringify(ROOT));
    write('src/wiki-sdd/mcp.json', JSON.stringify(PORTABLE_MCP));
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/.mcp.json')).toBe(`{
  "mcpServers": {
    "wiki": {
      "type": "stdio",
      "command": "node",
      "args": [
        "./scripts/run-kmd.mjs",
        "mcp"
      ],
      "cwd": ".",
      "env_vars": [
        "WIKI_VAULT",
        "KMD_PROJECT_DIR",
        "LOG_LEVEL"
      ]
    }
  }
}
`);
    write('plugins/codex/wiki-sdd/.mcp.json', 'hand edit');
    expect(render(root, manifest(), 'check').mismatches).toContain(
      'codex: .mcp.json: differs from rendered output'
    );
  });
});

describe('extension dirs', () => {
  it('places the claude extension: hooks.json and README into the flavor, the wrapper a copy of the launcher', () => {
    write('src/wiki-sdd/scripts/run-kmd.mjs', 'launcher bytes\n');
    write('src/wiki-sdd/com.anthropic.claude-code/hooks.json', '{"hooks":{"Stop":[]}}\n');
    write('src/wiki-sdd/com.anthropic.claude-code/README.md', '# claude adapter\n');
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('plugins/claude/wiki-sdd/hooks/hooks.json')).toBe('{"hooks":{"Stop":[]}}\n');
    expect(read('plugins/claude/wiki-sdd/README.md')).toBe('# claude adapter\n');
    expect(read('plugins/claude/wiki-sdd/hooks/run-kmd-hook.mjs')).toBe('launcher bytes\n');
    expect(existsSync(join(root, 'plugins/codex/wiki-sdd/hooks/hooks.json'))).toBe(false);

    write('plugins/claude/wiki-sdd/hooks/hooks.json', 'hand edit');
    expect(render(root, manifest(), 'check').mismatches).toContain(
      'claude: hooks/hooks.json: differs from rendered output'
    );
  });

  it('places the codex extension the same way', () => {
    write('src/wiki-sdd/scripts/run-kmd.mjs', 'launcher bytes\n');
    write('src/wiki-sdd/com.openai.codex/hooks.json', '{"hooks":{"Stop":[]}}\n');
    write('src/wiki-sdd/com.openai.codex/README.md', '# codex adapter\n');
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    expect(read('plugins/codex/wiki-sdd/hooks/hooks.json')).toBe('{"hooks":{"Stop":[]}}\n');
    expect(read('plugins/codex/wiki-sdd/README.md')).toBe('# codex adapter\n');
    expect(read('plugins/codex/wiki-sdd/hooks/run-kmd-hook.mjs')).toBe('launcher bytes\n');
  });

  it('places the cortex extension: hooks inline in the repo-root manifest, activation at the repo root, its own resolver and README in the flavor', () => {
    write(
      'src/wiki-sdd/com.snowflake.cortex/hooks.json',
      '{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}\n'
    );
    write('src/wiki-sdd/com.snowflake.cortex/activation.md', '# inactive\n');
    write('src/wiki-sdd/com.snowflake.cortex/run-kmd-hook.mjs', 'npx-free resolver\n');
    write('src/wiki-sdd/com.snowflake.cortex/README.md', '# coco adapter\n');
    write('.cortex-plugin/plugin.json', JSON.stringify({ name: 'stale', hooks: { Carried: [] } }));
    expect(render(root, manifest(), 'write').problems).toEqual([]);
    const cortex = JSON.parse(read('.cortex-plugin/plugin.json')) as Record<string, unknown>;
    expect(cortex.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] });
    expect(read('.cortex-plugin/activation.md')).toBe('# inactive\n');
    expect(read('plugins/coco/wiki-sdd/hooks/run-kmd-hook.mjs')).toBe('npx-free resolver\n');
    expect(read('plugins/coco/wiki-sdd/README.md')).toBe('# coco adapter\n');
  });

  it('rejects an unknown top-level directory or extension namespace in the Package', () => {
    write('src/wiki-sdd/hooks/run-kmd-hook.mjs', 'stray wrapper\n');
    write('src/wiki-sdd/org.example.harness/hooks.json', '{}\n');
    const problems = render(root, manifest(), 'write').problems;
    expect(problems).toEqual([
      expect.stringMatching(/^hooks\/: not a Package directory/),
      expect.stringMatching(/^org\.example\.harness\/: unknown extension namespace/)
    ]);
    expect(existsSync(join(root, 'plugins/claude/wiki-sdd/skills/foo/SKILL.md'))).toBe(false);
  });
});
