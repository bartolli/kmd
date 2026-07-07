## [v0.5.0] - 2026-07-07

### Added

- `kmd config [<vault-root>]` — prints `vault:` / `index:` / `synced:` resolution (arg > `$WIKI_VAULT`); with no vault resolvable, lists every known vault from the per-vault index metas
- `prime` response carries `vault_root` (markdown line + `structuredContent`); `wiki://authoring` opens with the vault root
- index `meta` table (`vault_root`, `last_synced`), written by `kmd sync` and the MCP server at startup

### Changed

- per-vault index layout: `$KMD_HOME/db/{basename}-{hash8 of resolved root}/index.db` (default `KMD_HOME` = `~/.kmd`) replaces the single `~/.kmd/db/index.db` — vaults never share or clobber an index. Run `kmd sync` once after upgrade; the legacy file is ignored and may be deleted
- `kmd db reset [<vault-root>]` deletes the resolved vault's index directory only

## [v0.4.0] - 2026-07-06

### Added

- `vault.yaml` `kinds` entries accept object form `{name, signal, where}` for custom kinds; served kind selector and `wiki://template/{name}` follow from the declaration
- `authoring_rules_extra` / `sync_protocol_extra` vault.yaml fields append to the served defaults instead of replacing them
- `methodologies` list is the sole authority for scope and page methodology values — no hard-coded enum
- `kmd validate`: custom-kind universal floor (title, summary, updated) as warnings; `custom-kind-template` warning when a declared custom kind has no `templates/{name}.md`
- `vault.yaml.example`: complete annotated reference for every field

### Changed

- Scope `methodology` validated against the `methodologies` list at `vault.yaml` load (fail-loud)
- Non-canonical `statuses` lists served as a plain enumeration in `wiki://authoring` instead of the default lifecycle arrows

## [v0.3.0] - 2026-06-29

### Changed

- `wiki://authoring` resource self-contained: authoring rules and resync protocol built from defaults, no vault CLAUDE.md filesystem read
- `vault.yaml` accepts optional `authoring_rules` and `sync_protocol` string fields; override built-in defaults when present
- `registerAuthoringResource` no longer reads from disk at serve time; output determined at registration by `VaultConfig`

## [v0.2.0] - 2026-06-28

### Added

- `wiki://authoring` MCP resource: config-driven kind selector, controlled vocabulary, authoring rules (from vault CLAUDE.md), template reference
- `wiki://templates` MCP resource: index of all 11 template URIs with descriptions
- Kind selector derived from `vault.yaml` kinds; pedagogy entries for all 12 standard kinds; unknown kinds degrade to `—` rows
- `prime` markdown output ends with `wiki://authoring` footer
- README: `vault.yaml` example and frontmatter page examples

### Fixed

- Vitest config excludes `dist/`; stale compiled test artifacts in `dist/src/` no longer shadow source tests

## [v0.1.1] - 2026-06-22

### Fixed

- `sanitizeFtsQuery` extracted to `lib/fts.ts`; unicode-aware `[^\p{L}\p{N}\s]` strip — accented letters preserved, `_` stripped (matches unicode61 tokenizer)
- `kmd` bin path normalized to `dist/kmd.mjs` (no leading `./`)

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
