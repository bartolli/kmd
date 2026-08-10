import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expandVars,
  findProjectTier,
  globalConfigPath,
  loadGlobalConfig,
  resolveVaultRoot,
  setGlobalConfigValue,
  unsetGlobalConfigValue
} from './kmd-config.js';

let home: string;
let project: string;
const savedKmdHome = process.env.KMD_HOME;

beforeEach(() => {
  // realpath: the resolver canonicalizes, and macOS tmpdir is a symlink
  home = realpathSync(mkdtempSync(join(tmpdir(), 'kmd-cfg-home-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'kmd-cfg-project-')));
  process.env.KMD_HOME = home;
});

afterEach(() => {
  if (savedKmdHome === undefined) delete process.env.KMD_HOME;
  else process.env.KMD_HOME = savedKmdHome;
});

function makeVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vault.yaml'), 'scopes: {}\n');
}

function writeTierConfig(root: string, file: string, content: string): void {
  mkdirSync(join(root, '.kmd'), { recursive: true });
  writeFileSync(join(root, '.kmd', file), content);
}

describe('expandVars', () => {
  it('substitutes set variables and honors :-defaults', () => {
    expect(expandVars(`\${A}/x`, { A: '/a' })).toBe('/a/x');
    expect(expandVars(`\${A:-/fallback}/x`, {})).toBe('/fallback/x');
    expect(expandVars('no vars', {})).toBe('no vars');
  });

  it('throws on an unset variable with no default', () => {
    expect(() => expandVars(`\${MISSING}/x`, {})).toThrow(/MISSING/);
  });
});

describe('global config', () => {
  it('absent file is an empty config', () => {
    expect(loadGlobalConfig()).toEqual({});
  });

  it('set / get / unset round-trip preserving comments', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(globalConfigPath(), '# my kmd config\n');
    setGlobalConfigValue('default_vault', '/vaults/main');
    expect(loadGlobalConfig().default_vault).toBe('/vaults/main');
    expect(readFileSync(globalConfigPath(), 'utf8')).toContain('# my kmd config');
    expect(unsetGlobalConfigValue('default_vault')).toBe(true);
    expect(loadGlobalConfig()).toEqual({});
    expect(unsetGlobalConfigValue('default_vault')).toBe(false);
  });

  it('rejects a malformed file loud', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(globalConfigPath(), 'unknown_key: true\n');
    expect(() => loadGlobalConfig()).toThrow(/invalid config/);
  });

  it('rejects a relative default_vault', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(globalConfigPath(), 'default_vault: relative/vault\n');
    expect(() => loadGlobalConfig()).toThrow(/absolute/);
  });
});

describe('findProjectTier', () => {
  it('finds a nested co-located vault by convention', () => {
    makeVault(join(project, 'vault'));
    expect(findProjectTier(project)).toMatchObject({
      vaultRoot: join(project, 'vault'),
      via: 'convention'
    });
  });

  it('finds a .kmd-marked root-layout vault by convention', () => {
    makeVault(project);
    mkdirSync(join(project, '.kmd'), { recursive: true });
    expect(findProjectTier(project)?.vaultRoot).toBe(project);
  });

  it('skips an unmarked bare vault.yaml and reports the candidate', () => {
    makeVault(project);
    const skipped: string[] = [];
    expect(findProjectTier(project, process.env, (c) => skipped.push(c))).toBeNull();
    expect(skipped).toEqual([join(project, 'vault.yaml')]);
  });

  it('walks up from a subdirectory to the nearest tier', () => {
    makeVault(join(project, 'vault'));
    const deep = join(project, 'packages', 'x');
    mkdirSync(deep, { recursive: true });
    expect(findProjectTier(deep)?.tierRoot).toBe(project);
  });

  it('config vault: resolves relative to the tier root', () => {
    writeTierConfig(project, 'config.yaml', 'vault: ../elsewhere/vault\n');
    expect(findProjectTier(project)?.vaultRoot).toBe(join(project, '..', 'elsewhere', 'vault'));
  });

  it('config.local.yaml beats config.yaml beats convention', () => {
    makeVault(join(project, 'vault'));
    writeTierConfig(project, 'config.yaml', 'vault: /shared/vault\n');
    expect(findProjectTier(project)).toMatchObject({ vaultRoot: '/shared/vault', via: 'config' });
    writeTierConfig(project, 'config.local.yaml', 'vault: /personal/vault\n');
    expect(findProjectTier(project)).toMatchObject({
      vaultRoot: '/personal/vault',
      via: 'local-config'
    });
  });

  it('expands env variables in config values and throws when unresolvable', () => {
    writeTierConfig(project, 'config.yaml', `vault: \${TEAM_VAULT:-vault}\n`);
    expect(findProjectTier(project, {})?.vaultRoot).toBe(join(project, 'vault'));
    expect(findProjectTier(project, { TEAM_VAULT: '/team/vault' })?.vaultRoot).toBe('/team/vault');
    writeTierConfig(project, 'config.yaml', `vault: \${TEAM_VAULT}\n`);
    expect(() => findProjectTier(project, {})).toThrow(/TEAM_VAULT/);
  });

  it('rejects a malformed tier config loud', () => {
    writeTierConfig(project, 'config.yaml', 'bogus: true\n');
    expect(() => findProjectTier(project)).toThrow(/invalid config/);
  });

  it('returns null with no tier signal', () => {
    expect(findProjectTier(project)).toBeNull();
  });
});

describe('resolveVaultRoot', () => {
  it('positional is authoritative over everything', () => {
    makeVault(join(project, 'vault'));
    expect(
      resolveVaultRoot({
        positional: '/explicit',
        projectDir: project,
        envVault: '/env',
        globalDefault: '/global'
      })
    ).toEqual({ root: '/explicit', source: 'positional' });
  });

  it('project tier beats --default-root, env, and global default', () => {
    makeVault(join(project, 'vault'));
    const res = resolveVaultRoot({
      projectDir: project,
      defaultRoot: '/plugin-default',
      envVault: '/env',
      globalDefault: '/global'
    });
    expect(res.root).toBe(join(project, 'vault'));
    expect(res.source).toBe('project-convention');
    expect(res.tierRoot).toBe(project);
  });

  it('--default-root beats env and global default', () => {
    expect(
      resolveVaultRoot({
        projectDir: project,
        defaultRoot: '/plugin-default',
        envVault: '/env',
        globalDefault: '/global'
      }).root
    ).toBe('/plugin-default');
  });

  it('a foreign unmarked vault.yaml does not capture rank 2 over env', () => {
    makeVault(project);
    const skipped: string[] = [];
    const res = resolveVaultRoot({
      projectDir: project,
      envVault: '/env',
      onSkip: (c) => skipped.push(c)
    });
    expect(res).toEqual({ root: '/env', source: 'env' });
    expect(skipped).toEqual([join(project, 'vault.yaml')]);
  });

  it('env beats global default; global default is last; none when empty', () => {
    expect(resolveVaultRoot({ envVault: '/env', globalDefault: '/global' })).toEqual({
      root: '/env',
      source: 'env'
    });
    expect(resolveVaultRoot({ globalDefault: '/global' })).toEqual({
      root: '/global',
      source: 'global-config'
    });
    expect(resolveVaultRoot({})).toEqual({ root: null, source: 'none' });
  });
});
