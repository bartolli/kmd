import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultConfig } from './config.js';
import {
  hasErrors,
  validateAmbiguousLinks,
  validatePage,
  validateSupersession,
  validateVault
} from './validate.js';

// Minimal in-memory vocabulary for per-page checks — mirrors the live vault.yaml
// shape without reading disk. Registers `artifact`/`prompt` (the ontology kinds).
const CFG: VaultConfig = {
  scopes: { sotto: { status: 'active' }, 'llm-wiki': { methodology: 'sdd', status: 'active' } },
  kinds: [
    'project',
    'spec',
    'adr',
    'plan',
    'story',
    'ops',
    'topic',
    'article',
    'src',
    'note',
    'artifact',
    'prompt'
  ],
  statuses: ['draft', 'active', 'superseded', 'archived'],
  methodologies: ['sdd', 'tdd', 'hybrid'],
  tags: { canonical: ['mcp', 'sync'], aliases: { 'model-context-protocol': 'mcp' } }
};
const REF = new Set<string>();

// A spec frontmatter that satisfies the required-fields floor — tests override
// one field at a time to isolate a single rule.
const wellFormedSpec = (over = '') =>
  `---\ntitle: X\nkind: spec\nscope: sotto\nstatus: active\nsummary: y\ntags: [x]\nsources: []\nupdated: 2026-06-19\n${over}---\nbody\n`;

describe('validatePage', () => {
  it('flags frontmatter that fails to parse (unquoted colon)', () => {
    // `summary: Status: Preview` — an unquoted `Word: phrase` scalar makes the
    // YAML parser throw; this is the live bug that silently halts sync mid-walk.
    const raw = '---\ntitle: X\nsummary: Status: Preview\n---\nbody\n';

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('frontmatter-parse');
    expect(findings[0]?.severity).toBe('error');
  });

  it('returns no findings for a well-formed page', () => {
    expect(validatePage('projects/sotto/spec/spec-x.md', wellFormedSpec(), CFG, REF)).toEqual([]);
  });
});

describe('vocabulary membership', () => {
  it('flags a kind absent from vault.yaml', () => {
    const raw = wellFormedSpec().replace('kind: spec', 'kind: speca');

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'kind-vocabulary' && f.severity === 'error')).toBe(true);
  });

  it('flags a status absent from vault.yaml', () => {
    const raw = wellFormedSpec().replace('status: active', 'status: provisional');

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'status-vocabulary' && f.severity === 'error')).toBe(
      true
    );
  });

  it('flags a path-derived scope absent from vault.yaml', () => {
    // scope is path-authoritative: `projects/{scope}/...` — frontmatter scope is ignored.
    const findings = validatePage('projects/bogus/spec/spec-x.md', wellFormedSpec(), CFG, REF);

    expect(findings.some((f) => f.rule === 'scope-vocabulary' && f.severity === 'error')).toBe(
      true
    );
  });

  it('flags a methodology absent from vault.yaml', () => {
    const raw =
      '---\ntitle: S\nkind: project\nscope: sotto\nstatus: active\nmethodology: waterfall\nphase: 1\nrepo: x\nsummary: y\ntags: []\nupdated: 2026-06-19\n---\nbody\n';

    const findings = validatePage('projects/sotto/index.md', raw, CFG, REF);

    expect(
      findings.some((f) => f.rule === 'methodology-vocabulary' && f.severity === 'error')
    ).toBe(true);
  });
});

describe('path authority (frontmatter scope/topic vs path)', () => {
  it('flags a frontmatter scope that disagrees with the path', () => {
    // path is authoritative: `projects/sotto/...` but frontmatter claims `llm-wiki`
    // (itself a valid scope — isolates path-authority from scope-vocabulary).
    const raw = wellFormedSpec().replace('scope: sotto', 'scope: llm-wiki');

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'path-authority' && f.severity === 'error')).toBe(true);
  });

  it('accepts a frontmatter scope that matches the path', () => {
    const findings = validatePage('projects/sotto/spec/spec-x.md', wellFormedSpec(), CFG, REF);

    expect(findings.some((f) => f.rule === 'path-authority')).toBe(false);
  });

  it('flags a frontmatter topic that disagrees with the path', () => {
    const raw =
      '---\ntitle: T\nkind: topic\nstatus: active\nsummary: y\ntags: []\nupdated: 2026-06-19\nconfidence: high\ntopic: other-cluster\n---\nbody\n';

    const findings = validatePage('research/mcp-patterns/index.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'path-authority' && f.severity === 'error')).toBe(true);
  });
});

describe('reference resolution', () => {
  it('flags a dangling wikilink whose target is not on disk', () => {
    const raw = wellFormedSpec().replace('body\n', 'see [[ghost-page]]\n');

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'dangling-link' && f.severity === 'error')).toBe(true);
  });

  it('accepts a wikilink whose basename is in the reference index', () => {
    const raw = wellFormedSpec().replace('body\n', 'see [[adr-infra-cli]]\n');

    const findings = validatePage(
      'projects/sotto/spec/spec-x.md',
      raw,
      CFG,
      new Set(['adr-infra-cli'])
    );

    expect(findings.some((f) => f.rule === 'dangling-link')).toBe(false);
  });

  it('flags a frontmatter reference (superseded_by) whose target does not resolve', () => {
    const raw =
      '---\ntitle: A\nkind: adr\nscope: sotto\nstatus: active\ntags: []\nupdated: 2026-06-19\nsupersedes:\nsuperseded_by: ghost-adr\nsources: []\n---\nbody\n';

    const findings = validatePage('projects/sotto/adr/adr-a.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'ref-resolves' && f.severity === 'error')).toBe(true);
  });

  it('does not flag an empty supersession key', () => {
    const raw =
      '---\ntitle: A\nkind: adr\nscope: sotto\nstatus: active\ntags: []\nupdated: 2026-06-19\nsupersedes:\nsuperseded_by:\nsources: []\n---\nbody\n';

    const findings = validatePage('projects/sotto/adr/adr-a.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'ref-resolves')).toBe(false);
  });

  it('ignores [[...]]-shaped syntax inside fenced and inline code', () => {
    // bash `[[ ]]` test in a fence, and a `[[wikilink]]` documentation example.
    const body = '```bash\nif [[ "$X" == *-* ]]; then :; fi\n```\nuse `[[example-link]]` inline\n';
    const raw = wellFormedSpec().replace('body\n', body);

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'dangling-link')).toBe(false);
  });
});

describe('primer link integrity', () => {
  it('flags a dangling wikilink in a title-less primer', () => {
    const raw = '---\nupdated: 2026-06-19\n---\nsee [[ghost-page]]\n';

    const findings = validatePage('projects/sotto/primer.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'dangling-link' && f.severity === 'error')).toBe(true);
  });

  it('accepts a resolving wikilink in a primer', () => {
    const raw = '---\nupdated: 2026-06-19\n---\nsee [[adr-infra-cli]]\n';

    const findings = validatePage(
      'projects/sotto/primer.md',
      raw,
      CFG,
      new Set(['adr-infra-cli'])
    );

    expect(findings.some((f) => f.rule === 'dangling-link')).toBe(false);
  });

  it('ignores a [[...]] example inside inline code in a primer', () => {
    // The primer documents the gap itself ("a stale `[[link]]` ..."); a backticked
    // example must not be mistaken for a real link.
    const raw = '---\nupdated: 2026-06-19\n---\na stale `[[link]]` in the first-read surface\n';

    const findings = validatePage('projects/sotto/primer.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'dangling-link')).toBe(false);
  });
});

describe('tag policy', () => {
  it('warns on a tag alias suggesting the canonical form, without failing the run', () => {
    const raw = wellFormedSpec().replace('tags: [x]', 'tags: [model-context-protocol]');

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    const alias = findings.find((f) => f.rule === 'tag-alias');
    expect(alias?.severity).toBe('warning');
    expect(alias?.message).toContain('mcp');
    expect(hasErrors(findings)).toBe(false);
  });
});

describe('tags required (open dimension, presence enforced)', () => {
  it('flags an indexed content page with empty tags', () => {
    const raw =
      '---\ntitle: X\nkind: spec\nscope: sotto\nstatus: active\nsummary: y\ntags: []\nsources: []\nupdated: 2026-06-19\n---\nbody\n';

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'tags-required' && f.severity === 'error')).toBe(true);
  });

  it('flags an indexed content page with no tags field at all', () => {
    const raw =
      '---\ntitle: X\nkind: adr\nscope: sotto\nstatus: active\nupdated: 2026-06-19\n---\nbody\n';

    const findings = validatePage('projects/sotto/adr/adr-x.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'tags-required' && f.severity === 'error')).toBe(true);
  });

  it('exempts tag-optional kinds (artifact, prompt) from the tags requirement', () => {
    const raw =
      '---\ntitle: X\nkind: artifact\nstatus: active\nupdated: 2026-06-19\n---\nbody\n';

    const findings = validatePage('projects/sotto/ops/pkg/thing.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'tags-required')).toBe(false);
  });

  it('accepts an indexed content page with non-empty tags (any value — open dimension)', () => {
    const findings = validatePage('projects/sotto/spec/spec-x.md', wellFormedSpec(), CFG, REF);

    expect(findings.some((f) => f.rule === 'tags-required')).toBe(false);
  });
});

describe('required fields', () => {
  it('flags a required field missing for the kind (no Gherkin scenario)', () => {
    const raw = wellFormedSpec().replace('summary: y\n', '');

    const findings = validatePage('projects/sotto/spec/spec-x.md', raw, CFG, REF);

    expect(
      findings.some((f) => f.rule === 'required-fields' && f.message.includes('summary'))
    ).toBe(true);
  });

  it('treats a present-but-empty field as satisfied (sources: [])', () => {
    // floor is key-presence, not non-emptiness — `sources: []` is a legitimate default.
    const findings = validatePage('projects/sotto/spec/spec-x.md', wellFormedSpec(), CFG, REF);

    expect(findings.some((f) => f.rule === 'required-fields')).toBe(false);
  });

  it('enforces the note floor for a kind-less note (kind inferred from notes/)', () => {
    // notes carry no `kind` key — sync infers it from location, and so must the floor.
    const raw = '---\ntitle: T\ntags: [x]\n---\nbody\n'; // missing updated

    const findings = validatePage('notes/some-thought.md', raw, CFG, REF);

    expect(
      findings.some((f) => f.rule === 'required-fields' && f.message.includes('updated'))
    ).toBe(true);
  });
});

describe('folder = slug prefix', () => {
  it('flags a file that violates its kind slug pattern (no Gherkin scenario)', () => {
    const findings = validatePage('projects/sotto/spec/wrong-name.md', wellFormedSpec(), CFG, REF);

    expect(findings.some((f) => f.rule === 'folder-slug' && f.severity === 'error')).toBe(true);
  });

  it('exempts kinds with no documented slug pattern (article, free naming)', () => {
    const raw =
      '---\ntitle: A\nkind: article\nstatus: active\ntags: []\nupdated: 2026-06-19\n---\nbody\n';

    const findings = validatePage('research/mcp-patterns/free-name.md', raw, CFG, REF);

    expect(findings.some((f) => f.rule === 'folder-slug')).toBe(false);
  });
});

describe('supersession', () => {
  it('flags status superseded with an empty superseded_by (no Gherkin scenario)', () => {
    const raw =
      '---\ntitle: A\nkind: adr\nscope: sotto\nstatus: superseded\ntags: []\nupdated: 2026-06-19\nsupersedes:\nsuperseded_by:\nsources: []\n---\nbody\n';

    const findings = validatePage('projects/sotto/adr/adr-a.md', raw, CFG, new Set());

    expect(findings.some((f) => f.rule === 'superseded-needs-link' && f.severity === 'error')).toBe(
      true
    );
  });

  it('flags a non-reciprocal supersedes link across ADRs (no Gherkin scenario)', () => {
    const pages = [
      { path: 'projects/sotto/adr/adr-a.md', data: { kind: 'adr', superseded_by: 'adr-b' } },
      { path: 'projects/sotto/adr/adr-b.md', data: { kind: 'adr' } }
    ];

    const findings = validateSupersession(pages);

    expect(
      findings.some((f) => f.rule === 'supersession-reciprocal' && f.severity === 'error')
    ).toBe(true);
  });

  it('accepts a reciprocal supersession pair', () => {
    const pages = [
      { path: 'projects/sotto/adr/adr-a.md', data: { kind: 'adr', superseded_by: 'adr-b' } },
      { path: 'projects/sotto/adr/adr-b.md', data: { kind: 'adr', supersedes: 'adr-a' } }
    ];

    expect(validateSupersession(pages).some((f) => f.rule === 'supersession-reciprocal')).toBe(
      false
    );
  });

  it('accepts an array-valued supersedes (one ADR superseding several)', () => {
    const pages = [
      { path: 'projects/sotto/adr/adr-a.md', data: { kind: 'adr', superseded_by: 'adr-b' } },
      {
        path: 'projects/sotto/adr/adr-b.md',
        data: { kind: 'adr', supersedes: ['adr-a', 'adr-z'] }
      }
    ];

    expect(validateSupersession(pages).some((f) => f.rule === 'supersession-reciprocal')).toBe(
      false
    );
  });
});

describe('ambiguous links (basename collision)', () => {
  const collide = new Map<string, string[]>([
    [
      'spec-architecture',
      ['projects/svlint/spec/spec-architecture.md', 'projects/alayacare/spec/spec-architecture.md']
    ]
  ]);

  it('warns on a bare link to a basename colliding across scopes with no same-scope copy', () => {
    const pages = [{ path: 'research/snowflake/dossier.md', body: 'see [[spec-architecture]]\n' }];

    const findings = validateAmbiguousLinks(pages, collide);

    expect(findings.some((f) => f.rule === 'ambiguous-link' && f.severity === 'warning')).toBe(true);
  });

  it('does not warn when a same-scope copy resolves the bare link', () => {
    const pages = [{ path: 'projects/svlint/primer.md', body: 'see [[spec-architecture]]\n' }];

    expect(validateAmbiguousLinks(pages, collide).some((f) => f.rule === 'ambiguous-link')).toBe(
      false
    );
  });

  it('does not warn on a path-qualified link to a colliding basename', () => {
    const pages = [
      {
        path: 'research/snowflake/dossier.md',
        body: 'see [[projects/svlint/spec/spec-architecture]]\n'
      }
    ];

    expect(validateAmbiguousLinks(pages, collide).some((f) => f.rule === 'ambiguous-link')).toBe(
      false
    );
  });

  it('does not warn on a bare link to a unique basename', () => {
    const pages = [{ path: 'research/snowflake/dossier.md', body: 'see [[adr-infra-cli]]\n' }];

    expect(validateAmbiguousLinks(pages, collide).some((f) => f.rule === 'ambiguous-link')).toBe(
      false
    );
  });
});

describe('validateVault', () => {
  it('surfaces a cross-scope ambiguous bare link (basename in two scopes, link in neither)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-validate-'));
    try {
      await writeFile(
        join(dir, 'vault.yaml'),
        'scopes:\n  svlint:\n    status: active\n  alayacare:\n    status: active\nkinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\ntags:\n  canonical: []\n  aliases: {}\n'
      );
      for (const s of ['svlint', 'alayacare']) {
        const specDir = join(dir, 'projects', s, 'spec');
        await mkdir(specDir, { recursive: true });
        await writeFile(join(specDir, 'spec-architecture.md'), 'arch body\n');
      }
      const resDir = join(dir, 'research', 'snowflake');
      await mkdir(resDir, { recursive: true });
      await writeFile(join(resDir, 'dossier.md'), 'see [[spec-architecture]]\n');

      const findings = await validateVault(dir);

      expect(
        findings.some(
          (f) => f.path === 'research/snowflake/dossier.md' && f.rule === 'ambiguous-link'
        )
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a malformed page found by walking the vault', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-validate-'));
    try {
      await writeFile(
        join(dir, 'vault.yaml'),
        'scopes:\n  sotto:\n    status: active\nkinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\ntags:\n  canonical: []\n  aliases: {}\n'
      );
      const specDir = join(dir, 'projects', 'sotto', 'spec');
      await mkdir(specDir, { recursive: true });
      await writeFile(
        join(specDir, 'spec-x.md'),
        '---\ntitle: X\nsummary: Status: Preview\n---\nbody\n'
      );

      const findings = await validateVault(dir);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('projects/sotto/spec/spec-x.md');
      expect(findings[0]?.rule).toBe('frontmatter-parse');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a dangling wikilink in a title-less primer (first-read-surface gate)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-validate-'));
    try {
      await writeFile(
        join(dir, 'vault.yaml'),
        'scopes:\n  sotto:\n    status: active\nkinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\ntags:\n  canonical: []\n  aliases: {}\n'
      );
      const scopeDir = join(dir, 'projects', 'sotto');
      await mkdir(scopeDir, { recursive: true });
      await writeFile(join(scopeDir, 'primer.md'), '---\nupdated: 2026-06-19\n---\nsee [[ghost-page]]\n');

      const findings = await validateVault(dir);

      expect(
        findings.some(
          (f) => f.path === 'projects/sotto/primer.md' && f.rule === 'dangling-link'
        )
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a wikilink into raw/ (target universe spans the whole vault)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-validate-'));
    try {
      await writeFile(
        join(dir, 'vault.yaml'),
        'scopes:\n  sotto:\n    status: active\nkinds: [spec]\nstatuses: [active]\nmethodologies: [sdd]\ntags:\n  canonical: []\n  aliases: {}\n'
      );
      const specDir = join(dir, 'projects', 'sotto', 'spec');
      await mkdir(specDir, { recursive: true });
      await writeFile(
        join(specDir, 'spec-x.md'),
        '---\ntitle: X\nkind: spec\nscope: sotto\nstatus: active\nsummary: y\ntags: []\nsources: []\nupdated: 2026-06-19\n---\nsee [[src-note]]\n'
      );
      const rawDir = join(dir, 'raw', 'sotto');
      await mkdir(rawDir, { recursive: true });
      await writeFile(join(rawDir, 'src-note.md'), 'raw source, not indexed\n');

      const findings = await validateVault(dir);

      expect(findings.some((f) => f.rule === 'dangling-link')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('hasErrors', () => {
  it('is true only when a finding has error severity', () => {
    expect(hasErrors([{ path: 'p', rule: 'r', severity: 'error', message: 'm' }])).toBe(true);
    expect(hasErrors([{ path: 'p', rule: 'r', severity: 'warning', message: 'm' }])).toBe(false);
    expect(hasErrors([])).toBe(false);
  });
});
