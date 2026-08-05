import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configJsonSchema, kindName, loadVaultConfig } from './vault-config.js';

describe('loadVaultConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiki-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a valid vault.yaml and returns its scopes', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n  codanna:\n    methodology: tdd\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd, tdd, hybrid]\n' +
        'tags:\n  canonical: [mcp]\n  aliases: {}\n'
    );

    const config = await loadVaultConfig(dir);

    expect(Object.keys(config.scopes).sort()).toEqual(['codanna', 'sotto']);
  });

  it('returns the controlled vocabulary lists', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec, adr, story, note]\n' +
        'statuses: [draft, active, superseded, archived]\n' +
        'methodologies: [sdd, tdd, hybrid]\n' +
        'tags:\n  canonical: [mcp]\n  aliases: {}\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.kinds).toContain('story');
    expect(config.statuses).toContain('archived');
    expect(config.methodologies).toEqual(['sdd', 'tdd', 'hybrid']);
  });

  it('returns canonical tags and their aliases', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: [mcp, fifo]\n  aliases:\n    model-context-protocol: mcp\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.tags.canonical).toContain('mcp');
    expect(config.tags.aliases['model-context-protocol']).toBe('mcp');
  });

  it('throws when vault.yaml violates the schema', async () => {
    // `sotto` is missing the required `status` field.
    await writeFile(join(dir, 'vault.yaml'), 'scopes:\n  sotto:\n    methodology: tdd\n');

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('accepts a scope methodology that the methodologies list declares', async () => {
    // The list is the authority — no hard-coded sdd|tdd|hybrid enum.
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  alayacare:\n    methodology: pdca-raci\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd, pdca-raci]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.scopes.alayacare?.methodology).toBe('pdca-raci');
  });

  it('rejects a scope methodology missing from the methodologies list', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    methodology: waterfall\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/not in the methodologies list/);
  });

  it('accepts object-form kind entries carrying selector pedagogy', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds:\n  - spec\n  - name: experiment\n    signal: Lab experiment log\n    where: "`projects/{scope}/lab/{slug}.md`"\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.kinds.map(kindName)).toEqual(['spec', 'experiment']);
  });

  it('rejects an object-form kind entry missing its pedagogy fields', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds:\n  - name: experiment\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('returns the additive pedagogy override fields when present', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'authoring_rules_extra: |\n  - Extra rule.\n' +
        'sync_protocol_extra: |\n  Extra protocol line.\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.authoring_rules_extra).toContain('Extra rule.');
    expect(config.sync_protocol_extra).toContain('Extra protocol line.');
  });

  it('returns scoped trigger lists', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: release-protocol\n      on: prompt\n      enforce: inject\n      keywords: [release]\n      text: "Release protocol."\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.triggers_extra?.sotto?.[0]?.id).toBe('release-protocol');
  });

  it('rejects duplicate trigger ids within a scope list', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n' +
        '    - id: dup\n      on: prompt\n      enforce: inject\n      keywords: [a]\n      text: "A."\n' +
        '    - id: dup\n      on: prompt\n      enforce: inject\n      keywords: [b]\n      text: "B."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/duplicate trigger id "dup"/);
  });

  it('rejects a prompt trigger with neither keywords nor intent', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: bare\n      on: prompt\n      enforce: inject\n      text: "T."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/needs keywords or intent/);
  });

  it('rejects a pretool trigger with no matcher at all', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: wide\n      on: pretool\n      enforce: block\n      reason: "R."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(
      /needs a tool, args_match, or files matcher/
    );
  });

  it('accepts files globs as the sole matcher of a pretool trigger', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: no-dist\n      on: pretool\n      enforce: block\n      files: ["dist/**"]\n      reason: "Generated output."\n'
    );

    const config = await loadVaultConfig(dir);

    expect(config.triggers_extra?.sotto?.[0]?.files).toEqual(['dist/**']);
  });

  it('rejects files globs on a prompt trigger', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: misfiled\n      on: prompt\n      enforce: inject\n      keywords: [release]\n      files: ["docs/**"]\n      text: "T."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/files applies to pretool triggers only/);
  });

  it('rejects a block trigger without a reason', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: gate\n      on: pretool\n      enforce: block\n      tool: Bash\n      args_match: "git tag"\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/needs a reason/);
  });

  it('accepts _all under triggers_extra and rejects it under triggers', async () => {
    const body =
      'scopes:\n  sotto:\n    status: active\n' +
      'kinds: [spec]\n' +
      'statuses: [active]\n' +
      'methodologies: [sdd]\n' +
      'tags:\n  canonical: []\n  aliases: {}\n';
    const entry =
      '  _all:\n    - id: skill-notes\n      on: prompt\n      enforce: inject\n      keywords: [scratchpad]\n      text: "Skill: /notes."\n';

    await writeFile(join(dir, 'vault.yaml'), `${body}triggers_extra:\n${entry}`);
    const config = await loadVaultConfig(dir);
    expect(config.triggers_extra?._all?.[0]?.id).toBe('skill-notes');

    await writeFile(join(dir, 'vault.yaml'), `${body}triggers:\n${entry}`);
    await expect(loadVaultConfig(dir)).rejects.toThrow(/"_all" is reserved for triggers_extra/);
  });

  it('accepts every dedup policy form on an inject trigger', async () => {
    const body =
      'scopes:\n  sotto:\n    status: active\n' +
      'kinds: [spec]\n' +
      'statuses: [active]\n' +
      'methodologies: [sdd]\n' +
      'tags:\n  canonical: []\n  aliases: {}\n';
    for (const dedup of ['session', 'never', '{minutes: 30}']) {
      await writeFile(
        join(dir, 'vault.yaml'),
        `${body}triggers_extra:\n  sotto:\n    - id: nudge\n      on: prompt\n      enforce: inject\n      keywords: [release]\n      text: "x"\n      dedup: ${dedup}\n`
      );
      await expect(loadVaultConfig(dir)).resolves.toBeDefined();
    }
  });

  it('rejects dedup on a block trigger', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: gate\n      on: pretool\n      enforce: block\n      tool: Bash\n      args_match: "git tag"\n      reason: "no"\n      dedup: session\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/may not set dedup/);
  });

  it('accepts builtin_hooks overrides and rejects unknown ids and fields', async () => {
    const body =
      'scopes:\n  sotto:\n    status: active\n' +
      'kinds: [spec]\n' +
      'statuses: [active]\n' +
      'methodologies: [sdd]\n' +
      'tags:\n  canonical: []\n  aliases: {}\n';

    await writeFile(
      join(dir, 'vault.yaml'),
      `${body}builtin_hooks:\n  resync:\n    reason: "Edit landed; sync held"\n    text: "sync failed"\n  handoff-gate:\n    reason: "not done yet"\n`
    );
    const config = await loadVaultConfig(dir);
    expect(config.builtin_hooks?.resync?.reason).toBe('Edit landed; sync held');
    expect(config.builtin_hooks?.['handoff-gate']?.reason).toBe('not done yet');

    await writeFile(join(dir, 'vault.yaml'), `${body}builtin_hooks:\n  bogus:\n    reason: "x"\n`);
    await expect(loadVaultConfig(dir)).rejects.toThrow();

    await writeFile(
      join(dir, 'vault.yaml'),
      `${body}builtin_hooks:\n  handoff-gate:\n    text: "x"\n`
    );
    await expect(loadVaultConfig(dir)).rejects.toThrow();
  });

  it('accepts orient and reorient text overrides and rejects reason on them', async () => {
    const body =
      'scopes:\n  sotto:\n    status: active\n' +
      'kinds: [spec]\n' +
      'statuses: [active]\n' +
      'methodologies: [sdd]\n' +
      'tags:\n  canonical: []\n  aliases: {}\n';

    await writeFile(
      join(dir, 'vault.yaml'),
      `${body}builtin_hooks:\n  orient:\n    text: "prime first"\n  reorient:\n    text: "re-prime"\n`
    );
    const config = await loadVaultConfig(dir);
    expect(config.builtin_hooks?.orient?.text).toBe('prime first');
    expect(config.builtin_hooks?.reorient?.text).toBe('re-prime');

    await writeFile(join(dir, 'vault.yaml'), `${body}builtin_hooks:\n  orient:\n    reason: "x"\n`);
    await expect(loadVaultConfig(dir)).rejects.toThrow();
  });

  it('accepts an object-form when predicate with fresh and than globs', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: retro-gate\n      on: pretool\n      enforce: block\n      tool: Bash\n      args_match: "git tag"\n' +
        '      when:\n        name: newer-than\n        fresh: ["notes/sotto-retro-*.md"]\n        than: ["projects/sotto/ops/release-*.md"]\n' +
        '      reason: "Retro gate."\n'
    );

    const config = await loadVaultConfig(dir);
    const when = config.triggers_extra?.sotto?.[0]?.when;

    expect(typeof when).toBe('object');
    expect((when as { name: string }).name).toBe('newer-than');
  });

  it('rejects an object-form when with an unknown predicate name', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: bad\n      on: pretool\n      enforce: block\n      tool: Bash\n' +
        '      when:\n        name: fresher-than\n        fresh: ["a"]\n        than: ["b"]\n' +
        '      reason: "R."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('rejects newer-than without both fresh and than globs', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: half\n      on: pretool\n      enforce: block\n      tool: Bash\n' +
        '      when:\n        name: newer-than\n        fresh: ["a"]\n' +
        '      reason: "R."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('rejects an invalid trigger regex', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: bad\n      on: prompt\n      enforce: inject\n      intent: ["cut (a release"]\n      text: "T."\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/invalid regex/);
  });

  it('throws when a required vocabulary section is missing', async () => {
    // `tags` is required — an incomplete config is not a single source of truth.
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\n' +
        'statuses: [active]\n' +
        'methodologies: [sdd]\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/Invalid vault\.yaml/);
  });

  it('throws when vault.yaml is absent', async () => {
    await expect(loadVaultConfig(dir)).rejects.toThrow(/not found/);
  });

  it('is vault-agnostic — one loader yields each vault its own vocabulary', async () => {
    const other = await mkdtemp(join(tmpdir(), 'wiki-config-other-'));
    try {
      await writeFile(
        join(dir, 'vault.yaml'),
        'scopes:\n  sotto:\n    status: active\n' +
          'kinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\n' +
          'tags:\n  canonical: []\n  aliases: {}\n'
      );
      await writeFile(
        join(other, 'vault.yaml'),
        'scopes:\n  elsewhere:\n    status: active\n' +
          'kinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\n' +
          'tags:\n  canonical: []\n  aliases: {}\n'
      );

      const a = await loadVaultConfig(dir);
      const b = await loadVaultConfig(other);

      expect(Object.keys(a.scopes)).toEqual(['sotto']);
      expect(Object.keys(b.scopes)).toEqual(['elsewhere']);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('rejects an unknown top-level key loud — a typo never silently does nothing', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'authoring_rules_xtra: "typo"\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/authoring_rules_xtra/);
  });

  it('rejects an unknown key inside a scope entry', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n    repos: /x\n' +
        'kinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/repos/);
  });

  it('rejects an unknown key inside a trigger', async () => {
    await writeFile(
      join(dir, 'vault.yaml'),
      'scopes:\n  sotto:\n    status: active\n' +
        'kinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\n' +
        'tags:\n  canonical: []\n  aliases: {}\n' +
        'triggers_extra:\n  sotto:\n    - id: t\n      on: prompt\n      enforce: inject\n' +
        '      keywords: [x]\n      text: "T."\n      keyword: [oops]\n'
    );

    await expect(loadVaultConfig(dir)).rejects.toThrow(/keyword/);
  });
});

describe('configJsonSchema', () => {
  it('emits the draft-07 structural contract', () => {
    const schema = configJsonSchema() as {
      $schema: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { description?: string }>;
    };

    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['scopes', 'kinds', 'statuses', 'methodologies', 'tags']);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'authoring_rules',
      'authoring_rules_extra',
      'builtin_hooks',
      'kinds',
      'methodologies',
      'scopes',
      'statuses',
      'sync_protocol',
      'sync_protocol_extra',
      'tags',
      'triggers',
      'triggers_extra'
    ]);
    expect(schema.properties.scopes?.description).toContain('projects/');
  });

  it('keeps the when-predicate union including the string shorthand', () => {
    // biome-ignore lint/suspicious/noExplicitAny: structural walk of emitted JSON
    const schema = configJsonSchema() as any;
    const trigger = schema.properties.triggers_extra.additionalProperties.items;
    const whenForms = trigger.properties.when.anyOf.map((v: { type: string }) => v.type).sort();

    expect(whenForms).toEqual(['object', 'string']);
    expect(trigger.additionalProperties).toBe(false);
  });
});
