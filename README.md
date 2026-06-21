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
├── vault.yaml              # controlled vocabulary
├── templates/               # frontmatter templates → MCP resources
├── projects/{scope}/        # specs, ADRs, plans, stories
├── research/{topic}/        # articles, sources
└── notes/                   # low-ceremony capture
```

## Development

Requires Node.js 22+ (`node:sqlite` FTS5) and pnpm 11+.

```bash
pnpm install
pnpm -r run typecheck && pnpm -r run test && pnpm lint
```

## License

MIT
