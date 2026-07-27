import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindName, loadVaultConfig } from './config.js';

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
});
