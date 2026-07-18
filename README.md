# kmd — knowledge-markdown

CLI + MCP server for structured markdown knowledge vaults. Validate, index (SQLite FTS5), and serve content to AI agents — one `npx` away.

Same primitives as [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) (markdown + YAML frontmatter + directory tree), but opinionated where OKF is minimal:

| | OKF | kmd |
|---|---|---|
| Vocabulary | open — producer picks `type` values | controlled — `vault.yaml` defines kinds, scopes, statuses, tags; `kmd validate` enforces |
| Structure | flat — organize however | three domains: `projects/` · `research/` · `notes/` |
| Validation | none — format spec only | deterministic, LLM-free; gates sync + pre-commit hook |
| Cross-refs | bundle-relative `/path.md` | `[[wikilinks]]` (Obsidian-native, rename-safe, no-dangling guarantee) |
| Agent surface | none — bring your own | two MCP tools (`prime`, `search`) + template resources |
| Infrastructure | n/a | `node:sqlite` FTS5; zero external deps |

## Install

```bash
npx @bartolli/kmd --help
```

## Commands

```
kmd validate [<path>]        deterministic vault checker (default: $WIKI_VAULT)
kmd sync                     vault → SQLite index (runs validate first)
kmd mcp [<vault-root>]       stdio MCP server
kmd config [<vault-root>]    print vault + index resolution; no vault → list known vaults
kmd db reset [<vault-root>]  delete the vault's index
```

The index is **per-vault**: `~/.kmd/db/{vault-key}/index.db`, keyed by the resolved vault root — multiple vaults never share or clobber an index, and re-pointing a server at a different vault can't serve stale rows from the old one. `kmd config` prints the resolution (or lists every known vault), and agents get `vault_root` in every `prime` response — that's the base for resolving `search`'s vault-relative paths.

## MCP registration

```json
{
  "mcpServers": {
    "wiki": {
      "command": "npx",
      "args": ["-y", "@bartolli/kmd", "mcp", "/absolute/path/to/vault"]
    }
  }
}
```

Two tools:

- **`prime(scope, task?)`** — orientation briefing: identity, primer, active ADRs, plan, vocabulary, hubs, task-relevant pages.
- **`search(query, scope?, kind?, limit?)`** — FTS5 ranked candidates `{path, title, kind, summary, score}`. Never page bodies.

Templates served as MCP resources at `wiki://template/{domain}/{kind}`.

## Vault structure

```
vault/
├── vault.yaml               # controlled vocabulary
├── templates/               # frontmatter templates → MCP resources
├── projects/{scope}/        # specs, ADRs, plans, stories
├── research/{topic}/        # articles, sources
└── notes/                   # low-ceremony capture
```

`vault.yaml` is the controlled vocabulary and the served pedagogy for one vault. Loading is fail-loud: an invalid file stops the MCP server from starting and blocks `kmd sync` / `kmd validate`. The schema lives byte-identically in `packages/cli/src/config.ts` and `packages/mcp/src/vault-config.ts` — edit both or neither. A complete annotated example: [`vault.yaml.example`](vault.yaml.example).

| Field | Type | Required | Enforced by |
|---|---|---|---|
| `scopes` | map of scope name → entry | yes | schema; `prime(scope)` resolves against it |
| `scopes.*.status` | string | yes | schema (free string; keep within `statuses` by convention) |
| `scopes.*.repo` | string | no | — (informational) |
| `scopes.*.methodology` | string | no | schema — must appear in `methodologies` |
| `kinds` | (string \| `{name, signal, where}`)[] | yes | `kmd validate`: page `kind` must be listed; object form adds a kind-selector row |
| `statuses` | string[] | yes | `kmd validate`: page `status` must be listed |
| `methodologies` | string[] | yes | `kmd validate` (pages) + schema (scope entries) |
| `tags.canonical` | string[] | yes | membership check currently deferred; `prime` surfaces `top_tags` |
| `tags.aliases` | map alias → canonical | yes | `kmd validate` warns when a page uses an alias |
| `authoring_rules` | multiline string | no | replaces `wiki://authoring` § Authoring rules (escape hatch) |
| `authoring_rules_extra` | multiline string | no | appended after the served § Authoring rules |
| `sync_protocol` | multiline string | no | replaces `wiki://authoring` § Resync protocol (escape hatch) |
| `sync_protocol_extra` | multiline string | no | appended after the served § Resync protocol |

Kinds with built-in authoring pedagogy (kind-selector rows): `project`, `spec`, `adr`, `plan`, `story`, `ops`, `topic`, `article`, `src`, `note`, `artifact`, `prompt`. A custom kind gets its row via the object form: `{name, signal, where}` — *signal* is when to pick the kind, *where* is the path pattern.

```yaml
scopes:
  my-app:
    methodology: sdd        # optional — any value from `methodologies`
    status: active
  research-notes:
    status: active

kinds: [spec, adr, plan, story, ops, article, src, note]
statuses: [draft, active, superseded, archived]
methodologies: [sdd, tdd, hybrid]

tags:
  canonical: [auth, api, sync]
  aliases:
    authentication: auth    # normalize on write; warn on validate
```

## Served pedagogy

The MCP resource `wiki://authoring` is how agents learn to write in your vault: it opens with the vault root (so every path it teaches is immediately actionable), then a kind-selector table, the controlled vocabulary, authoring rules (structure, frontmatter discipline, content quality bar, linking), and the resync protocol. It ships with strong defaults and is assembled fresh from `vault.yaml` on every read — edit the config, and the next agent session works under the new rules. No rebuild, no restart.

### Add vault-specific rules — keep every default

The `_extra` fields append to the served sections. You keep the full built-in rulebook, and future default improvements keep flowing to your vault:

```yaml
authoring_rules_extra: |
  - **Diagrams live in `assets/`** as `.excalidraw.md` — embed with `![[...]]`, don't inline SVG.
  - **Meeting notes are one file per meeting**: `notes/mtg-{date}-{topic}.md`.

sync_protocol_extra: |
  Session-closing primer resyncs run /retro first: convert every finding
  into wiki artifacts, then author the primer from the corrected state.
```

Served result: § Authoring rules is the complete default set with your two rules at the end; § Resync protocol gains the retro gate after the default edit-validate-sync loop.

### Teach the agent a custom kind

A `kinds` entry in object form adds a row to the served kind selector — `signal` is *when to pick this kind*, `where` is *the path pattern to follow*:

```yaml
kinds:
  - spec
  - adr
  - note
  - name: experiment
    signal: Hypothesis, setup, and outcome of a training run
    where: "`projects/{scope}/lab/exp-{slug}.md`"
```

Served kind selector:

```markdown
| Signal | Kind | Where |
|---|---|---|
| How a system works (state of world, not decision) | **spec** | `projects/{scope}/spec/spec-{slug}.md` |
| Decision between alternatives, commits direction | **adr** | `projects/{scope}/adr/adr-{slug}.md` |
| Low-ceremony capture, sort later | **note** | `notes/{slug}.md` |
| Hypothesis, setup, and outcome of a training run | **experiment** | `projects/{scope}/lab/exp-{slug}.md` |
```

…and `kmd validate` accepts `kind: experiment` on pages. Plain-string entries use the built-in pedagogy; the object form also lets you reword a built-in kind's row.

The template comes with it: drop `templates/experiment.md` in the vault and it's served at `wiki://template/experiment`, listed in `wiki://templates` with the kind's `signal` as its description — same fresh-from-disk serving as the built-ins. A declared custom kind without its template file is a `kmd validate` warning, so the gap never goes unnoticed.

Custom-kind pages get a **soft universal floor** instead of the built-ins' strict one: missing `title`, `summary`, or `updated` warns but never blocks. Those three are the fields the index serves — `title`/`summary` feed search, `updated` feeds `prime` ordering — so the nudge keeps pages retrievable while everything beyond the floor stays the kind's own business.

### Bring your own methodology

The `methodologies` list is the single authority for page frontmatter *and* scope entries — no hard-coded set:

```yaml
scopes:
  care-ops:
    methodology: pdca-raci   # legal because the list declares it
    status: active

methodologies: [sdd, tdd, hybrid, pdca-raci]
```

A scope methodology missing from the list fails the whole file at load — fail-loud, before any index write.

### Replace wholesale (escape hatch)

`authoring_rules` / `sync_protocol` (without `_extra`) replace the served section entirely. Every default rule not restated is gone — reach for this only when your vault genuinely runs a different rulebook. Custom `statuses` behave similarly on the serving side: only the canonical `draft → active → superseded → archived` set is presented as a one-directional lifecycle; any other list is served as a plain enumeration, and the ordering pedagogy is yours to supply via `authoring_rules_extra`.

## Pages

Every page has YAML frontmatter validated against `vault.yaml`. Use the templates in `templates/` (or `wiki://template/{domain}/{kind}` via MCP) — don't hand-roll.

```yaml
# projects/my-app/adr/adr-sqlite-index.md
---
title: "SQLite for the index"
kind: adr
status: active
tags: [storage]
created: "2025-03-15"
updated: 2025-06-01
---
```

```yaml
# research/retrieval/snowflake-cortex.md
---
title: "Snowflake Cortex architecture"
kind: article
status: draft
tags: [retrieval]
created: "2025-04-20"
updated: 2025-04-20
---
```

```yaml
# notes/caching-thought.md
---
title: "Quick thought on caching"
tags: [perf]
created: "2025-06-28"
updated: 2025-06-28
---
```

`kind` selects the template shape. `status` tracks lifecycle. Notes skip `kind` — location implies it. All values must appear in `vault.yaml` or validate fails.

## Claude Code plugin

The repo doubles as a Claude Code plugin marketplace (`kmd`) shipping [`wiki-sdd`](plugins/claude/wiki-sdd/README.md) — the wiki-native spec-driven development loop: skills for scope bootstrap, intent grilling, PRD synthesis, triage, issue slicing, TDD, and retro, plus a frontmatter guard hook and this MCP server preconfigured via `npx @bartolli/kmd`.

```bash
claude plugin marketplace add bartolli/kmd
claude plugin install wiki-sdd@kmd
```

## Codex plugin

The repo also provides a Codex marketplace (`kmd`) shipping [`wiki-sdd`](plugins/codex/wiki-sdd/README.md).

```bash
codex plugin marketplace add bartolli/kmd
codex plugin add wiki-sdd@kmd
```

Start a new Codex thread after installation so the plugin's skills and MCP tools are loaded.

## Development

Requires Node.js 22+ (`node:sqlite` FTS5) and pnpm 11+.

```bash
pnpm install
pnpm -r run typecheck && pnpm -r run test && pnpm lint
```

## License

MIT
