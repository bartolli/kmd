## [v0.1.0] - 2026-06-21

### Added

- `@bartolli/kmd` single esbuild bundle: `kmd sync`, `kmd validate`, `kmd mcp`, `kmd db reset`
- SQLite FTS5 local index at `~/.kmd/db/index.db`; zero native dependencies
- `kmd sync` — one-way vault → SQLite sync; walks `projects/`, `research/`, `notes/`; skips `raw/`, `templates/`
- `kmd validate` — vocabulary, reference, path-authority, primer-link, and tags-required rules; gates sync on pass
- `kmd mcp <vault-root>` — stdio MCP server; two tools: `prime(scope, task?)` and `search(query, scope?, kind?, limit?)`
- 11 template resources at `wiki://template/{domain}/{kind}` via `resources/list` + `resources/read`
- `vault.yaml` controlled vocabulary validated at server startup before any DB access
- Pino structured logging to stderr + `~/.local/state/wiki-mcp/server.log`
