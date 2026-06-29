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
kmd validate [<path>]     deterministic vault checker (default: $WIKI_VAULT)
kmd sync                  vault → SQLite index (runs validate first)
kmd mcp [<vault-root>]    stdio MCP server
kmd db reset              delete and recreate the index
```

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

`vault.yaml` defines what `kmd validate` enforces:

```yaml
scopes:
  my-app:
    methodology: sdd        # optional — shown in prime output
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

## Development

Requires Node.js 22+ (`node:sqlite` FTS5) and pnpm 11+.

```bash
pnpm install
pnpm -r run typecheck && pnpm -r run test && pnpm lint
```

## License

MIT
