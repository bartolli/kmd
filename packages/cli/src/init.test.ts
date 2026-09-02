import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { BUILT_IN_KINDS, configJsonSchema, loadVaultConfig } from '@llm-wiki/db/vault-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  promptYesNo,
  refreshSchemaFile,
  SCHEMA_FILE,
  STARTER_CONFIG,
  scaffoldVault
} from './init.js';
import { VAULT_TEMPLATES } from './init-templates.js';
import { hasErrors, validateVault } from './validate.js';

const TEMPLATE_FILES = [
  'note.md',
  'project-adr.md',
  'project-index.md',
  'project-intent.md',
  'project-ops.md',
  'project-plan.md',
  'project-primer.md',
  'project-spec.md',
  'project-story.md',
  'research-article.md',
  'research-index.md',
  'research-src.md'
];

describe('template clocks', () => {
  it('every template carries quoted UTC timestamp placeholders, never a bare date', () => {
    for (const [file, content] of Object.entries(VAULT_TEMPLATES)) {
      expect(content, file).toContain('updated: "{{timestamp}}"');
      expect(content, file).not.toContain('{{date}}');
      if (content.includes('created:')) expect(content, file).toContain('created: "{{timestamp}}"');
    }
  });
});

describe('primer and plan templates', () => {
  it('the primer template carries the four sections and the budget; the plan template has no Status Log', () => {
    const primer = VAULT_TEMPLATES['project-primer.md'] ?? '';
    for (const heading of ['## Focus', '## Next', '## Open', '## Read order']) {
      expect(primer).toContain(heading);
    }
    expect(primer).toContain('300 words');
    expect(VAULT_TEMPLATES['project-plan.md']).not.toContain('Status Log');
  });
});

describe('starter vocabulary', () => {
  it('the starter lists every built-in kind', () => {
    const starterKinds = STARTER_CONFIG.kinds.map((k) => (typeof k === 'string' ? k : k.name));

    for (const kind of BUILT_IN_KINDS) {
      expect(starterKinds).toContain(kind);
    }
  });
});

describe('scaffoldVault', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-init-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('round-trips: the scaffolded vault.yaml loads back equal to the starter', async () => {
    const root = await scaffoldVault(join(base, 'vault'));

    const loaded = await loadVaultConfig(root);

    expect(loaded).toEqual(STARTER_CONFIG);
  });

  it('scaffolds a vault that passes validate', async () => {
    const root = await scaffoldVault(join(base, 'vault'));

    const findings = await validateVault(root);

    expect(hasErrors(findings)).toBe(false);
  });

  it('a fresh vault accepts an intent: no kind-vocabulary finding', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    const yaml = await readFile(join(root, 'vault.yaml'), 'utf8');
    await writeFile(
      join(root, 'vault.yaml'),
      yaml.replace('scopes: {}', 'scopes:\n  demo:\n    status: active\n    methodology: sdd')
    );
    await mkdir(join(root, 'projects', 'demo', 'intent'), { recursive: true });
    await writeFile(
      join(root, 'projects', 'demo', 'intent', 'intent-probe.md'),
      [
        '---',
        'title: "Probe"',
        'kind: intent',
        'scope: demo',
        'status: draft',
        'summary: "probe"',
        'tags: [governance]',
        'origin: user',
        'sightings: 1',
        'sources: []',
        'created: "2026-09-02T20:00:00Z"',
        'updated: "2026-09-02T20:00:00Z"',
        '---',
        '',
        '# Probe',
        ''
      ].join('\n')
    );

    const findings = await validateVault(root);

    expect(findings.filter((f) => f.rule === 'kind-vocabulary')).toEqual([]);
  });

  it('writes the full built-in template set, byte-equal to the embedded copies', async () => {
    const root = await scaffoldVault(join(base, 'vault'));

    const written = (await readdir(join(root, 'templates'))).sort();
    expect(written).toEqual(TEMPLATE_FILES);
    for (const file of written) {
      expect(await readFile(join(root, 'templates', file), 'utf8')).toBe(VAULT_TEMPLATES[file]);
    }
  });

  it('creates the domain dirs and nested targets', async () => {
    const root = await scaffoldVault(join(base, 'a', 'b', 'vault'));

    const entries = (await readdir(root)).sort();
    expect(entries).toEqual([
      'notes',
      'projects',
      'research',
      'templates',
      'vault.schema.json',
      'vault.yaml'
    ]);
  });

  it('writes the yaml-language-server modeline as vault.yaml line 1', async () => {
    const root = await scaffoldVault(join(base, 'vault'));

    const raw = await readFile(join(root, 'vault.yaml'), 'utf8');

    expect(raw.startsWith('# yaml-language-server: $schema=./vault.schema.json\n')).toBe(true);
  });

  it('emits vault.schema.json matching the running engine', async () => {
    const root = await scaffoldVault(join(base, 'vault'));

    const schema = JSON.parse(await readFile(join(root, SCHEMA_FILE), 'utf8'));

    expect(schema).toEqual(configJsonSchema());
  });

  it('refreshSchemaFile restores a drifted schema and is idempotent', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await writeFile(join(root, SCHEMA_FILE), '{}');

    expect(await refreshSchemaFile(root)).toBe(true);
    expect(JSON.parse(await readFile(join(root, SCHEMA_FILE), 'utf8'))).toEqual(configJsonSchema());
    expect(await refreshSchemaFile(root)).toBe(false);
  });

  it('refuses a non-empty target and names the entries', async () => {
    const dir = join(base, 'occupied');
    await mkdir(dir);
    await writeFile(join(dir, 'existing.txt'), 'x');

    await expect(scaffoldVault(dir)).rejects.toThrow(/not empty.*existing\.txt/s);
  });

  it('refuses an existing vault with a distinguished error', async () => {
    const dir = join(base, 'vault');
    await scaffoldVault(dir);

    await expect(scaffoldVault(dir)).rejects.toThrow(/already a vault.*vault\.yaml exists/s);
  });

  it('throws loud when the target is a file', async () => {
    const file = join(base, 'a-file');
    await writeFile(file, 'x');

    await expect(scaffoldVault(file)).rejects.toThrow();
  });
});

describe('promptYesNo', () => {
  it('accepts y/yes case-insensitively and defaults to no', async () => {
    const cases: ReadonlyArray<[string, boolean]> = [
      ['y\n', true],
      ['Yes\n', true],
      ['\n', false],
      ['n\n', false],
      ['nope\n', false]
    ];
    for (const [answer, expected] of cases) {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      input.end(answer);

      expect(await promptYesNo('proceed? [y/N] ', input, output)).toBe(expected);
    }
  });
});
