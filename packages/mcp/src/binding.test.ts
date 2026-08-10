import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDirsFromRoots, resolveDeferredVault } from './binding.js';

describe('projectDirsFromRoots', () => {
  it('converts file:// URIs to local paths, in client order', () => {
    const a = pathToFileURL('/tmp/project-a').href;
    const b = pathToFileURL('/tmp/project-b').href;
    expect(projectDirsFromRoots([{ uri: a }, { uri: b }])).toEqual([
      '/tmp/project-a',
      '/tmp/project-b'
    ]);
  });

  it('skips non-file and malformed URIs', () => {
    expect(
      projectDirsFromRoots([
        { uri: 'https://example.com/repo' },
        { uri: 'file://%zz' },
        { uri: pathToFileURL('/tmp/ok').href }
      ])
    ).toEqual(['/tmp/ok']);
  });
});

describe('resolveDeferredVault', () => {
  let base: string;
  let project: string;

  beforeEach(async () => {
    // realpath: resolution canonicalizes, and macOS tmpdir is a symlink
    base = realpathSync(await mkdtemp(join(tmpdir(), 'mcp-binding-')));
    project = join(base, 'project');
    await mkdir(join(project, 'vault'), { recursive: true });
    await writeFile(join(project, 'vault', 'vault.yaml'), 'scopes: {}\n');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('binds the first client root that maps to a vault', async () => {
    const bare = join(base, 'no-tier');
    await mkdir(bare, { recursive: true });

    const resolution = resolveDeferredVault({
      rootDirs: [bare, project],
      cwd: base,
      env: {}
    });

    expect(resolution.root).toBe(join(project, 'vault'));
    expect(resolution.source).toBe('project-convention');
    expect(resolution.tierRoot).toBe(project);
  });

  it('a mapping root beats $WIKI_VAULT — roots are rank 2, env is rank 4', () => {
    const resolution = resolveDeferredVault({
      rootDirs: [project],
      cwd: base,
      envVault: join(base, 'env-vault'),
      env: {}
    });

    expect(resolution.root).toBe(join(project, 'vault'));
    expect(resolution.source).toBe('project-convention');
  });

  it('no mapping root falls through to --default-root > env > global, never the cwd walk', async () => {
    const bare = join(base, 'no-tier');
    await mkdir(bare, { recursive: true });

    // cwd sits inside a vault-carrying project, but roots are the one project
    // signal once the client declares them — cwd must not capture.
    const cwd = project;
    const common = { rootDirs: [bare], cwd, env: {} };

    const viaDefault = resolveDeferredVault({
      ...common,
      defaultRoot: '/fallback/default',
      envVault: '/fallback/env',
      globalDefault: '/fallback/global'
    });
    expect(viaDefault).toEqual({ root: '/fallback/default', source: 'default-root' });

    const viaEnv = resolveDeferredVault({
      ...common,
      envVault: '/fallback/env',
      globalDefault: '/fallback/global'
    });
    expect(viaEnv).toEqual({ root: '/fallback/env', source: 'env' });

    const viaGlobal = resolveDeferredVault({ ...common, globalDefault: '/fallback/global' });
    expect(viaGlobal).toEqual({ root: '/fallback/global', source: 'global-config' });

    const nothing = resolveDeferredVault(common);
    expect(nothing).toEqual({ root: null, source: 'none' });
  });

  it('an empty roots list is roots mode, not the cwd-fed fallback', () => {
    const resolution = resolveDeferredVault({
      rootDirs: [],
      cwd: project,
      defaultRoot: '/fallback/default',
      env: {}
    });

    expect(resolution).toEqual({ root: '/fallback/default', source: 'default-root' });
  });

  it('a client without the roots capability keeps the cwd-fed chain', () => {
    const resolution = resolveDeferredVault({
      rootDirs: null,
      cwd: join(project, 'src'),
      defaultRoot: '/fallback/default',
      env: {}
    });

    expect(resolution.root).toBe(join(project, 'vault'));
    expect(resolution.source).toBe('project-convention');
  });

  it('notifies onSkip for an unmarked bare vault.yaml met in a root walk', async () => {
    const foreign = join(base, 'foreign');
    await mkdir(join(foreign, 'sub'), { recursive: true });
    await writeFile(join(foreign, 'vault.yaml'), 'not_a_kmd_vault: true\n');

    const skipped: string[] = [];
    const resolution = resolveDeferredVault({
      rootDirs: [join(foreign, 'sub')],
      cwd: base,
      envVault: '/fallback/env',
      env: {},
      onSkip: (candidate) => skipped.push(candidate)
    });

    expect(resolution).toEqual({ root: '/fallback/env', source: 'env' });
    expect(skipped).toEqual([join(foreign, 'vault.yaml')]);
  });
});
