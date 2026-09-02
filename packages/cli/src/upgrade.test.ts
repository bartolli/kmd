import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVaultConfig } from '@llm-wiki/db/vault-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldVault } from './init.js';
import { VAULT_TEMPLATES } from './init-templates.js';
import { applyVaultDelta, diffVault, isBehind, upgradeVault } from './upgrade.js';

/** A vault scaffolded before `artifact`, `prompt`, and `intent` reached the starter. */
async function ageVault(root: string): Promise<void> {
  const yaml = await readFile(join(root, 'vault.yaml'), 'utf8');
  await writeFile(
    join(root, 'vault.yaml'),
    yaml.replace('  - artifact\n', '').replace('  - prompt\n', '').replace('  - intent\n', '')
  );
  await unlink(join(root, 'templates', 'project-intent.md'));
}

describe('diffVault', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-upgrade-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('names the missing kinds and the missing template on an older vault', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await ageVault(root);

    const delta = await diffVault(root);

    expect(delta.kinds).toEqual(['artifact', 'prompt', 'intent']);
    expect(delta.templates).toEqual(['project-intent.md']);
    expect(delta.statuses).toEqual([]);
    expect(delta.methodologies).toEqual([]);
    expect(delta.templatesDiffer).toEqual([]);
    expect(delta.domains).toEqual([]);
    expect(isBehind(delta)).toBe(true);
  });
});

describe('applyVaultDelta', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-upgrade-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('appends the missing kinds in place, keeps comments and the modeline, writes the template', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await ageVault(root);
    const aged = await readFile(join(root, 'vault.yaml'), 'utf8');
    await writeFile(join(root, 'vault.yaml'), aged.replace('kinds:\n', 'kinds:\n  # keep me\n'));

    await applyVaultDelta(root, await diffVault(root));

    const config = await loadVaultConfig(root);
    expect(config.kinds.slice(-3)).toEqual(['artifact', 'prompt', 'intent']);
    const yaml = await readFile(join(root, 'vault.yaml'), 'utf8');
    expect(yaml.split('\n')[0]).toMatch(/^# yaml-language-server: \$schema=/);
    expect(yaml).toContain('# keep me');
    expect(await readFile(join(root, 'templates', 'project-intent.md'), 'utf8')).toBe(
      VAULT_TEMPLATES['project-intent.md']
    );
    expect(isBehind(await diffVault(root))).toBe(false);
  });
});

describe('applyVaultDelta guards', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-upgrade-'));
  });

  afterEach(async () => {
    await chmod(join(base, 'vault', 'templates'), 0o755).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });

  it('a hand-edited template is informational: reported as differs, never a delta, never overwritten', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    const edited = `${VAULT_TEMPLATES['project-plan.md']}\n## House section\n`;
    await writeFile(join(root, 'templates', 'project-plan.md'), edited);

    const delta = await diffVault(root);
    await applyVaultDelta(root, delta);

    expect(delta.templatesDiffer).toEqual(['project-plan.md']);
    expect(isBehind(delta)).toBe(false);
    expect(await readFile(join(root, 'templates', 'project-plan.md'), 'utf8')).toBe(edited);
  });

  it('is idempotent: a second apply changes nothing and the vault reads current', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await ageVault(root);
    await applyVaultDelta(root, await diffVault(root));
    const once = await readFile(join(root, 'vault.yaml'), 'utf8');

    await applyVaultDelta(root, await diffVault(root));

    expect(await readFile(join(root, 'vault.yaml'), 'utf8')).toBe(once);
    expect(isBehind(await diffVault(root))).toBe(false);
  });

  it('writes vault.yaml last: a template write that fails leaves the vocabulary untouched', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await ageVault(root);
    const before = await readFile(join(root, 'vault.yaml'), 'utf8');
    await chmod(join(root, 'templates'), 0o500);

    await expect(applyVaultDelta(root, await diffVault(root))).rejects.toThrow();

    expect(await readFile(join(root, 'vault.yaml'), 'utf8')).toBe(before);
  });
});

describe('upgradeVault', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kmd-upgrade-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('reports a vault behind the starter with counts and exits 1, writing nothing', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await ageVault(root);
    const before = await readFile(join(root, 'vault.yaml'), 'utf8');

    const result = await upgradeVault(root, { apply: false });

    expect(result.code).toBe(1);
    expect(result.lines[0]).toBe('vault behind the starter: 3 kinds, 1 template');
    expect(result.lines).toContain('  kind: intent');
    expect(result.lines).toContain('  template: project-intent.md');
    expect(result.lines.at(-1)).toBe('run kmd init --upgrade --apply to write the delta');
    expect(await readFile(join(root, 'vault.yaml'), 'utf8')).toBe(before);
  });

  it('reports a current vault and exits 0', async () => {
    const root = await scaffoldVault(join(base, 'vault'));

    const result = await upgradeVault(root, { apply: false });

    expect(result.code).toBe(0);
    expect(result.lines).toEqual(['vault current with the starter']);
  });

  it('applies the delta, names each write, and exits 0', async () => {
    const root = await scaffoldVault(join(base, 'vault'));
    await ageVault(root);

    const result = await upgradeVault(root, { apply: true });

    expect(result.code).toBe(0);
    expect(result.lines).toContain('  applied kind: intent');
    expect(result.lines).toContain('  applied template: project-intent.md');
    expect(result.lines.at(-1)).toBe('vault current with the starter');
    expect(isBehind(await diffVault(root))).toBe(false);
  });
});
