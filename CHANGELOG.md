## [v0.7.0] - 2026-07-28

### Added

- `kmd init [<dir>] [--yes|-y]` — scaffolds a fresh vault: starter `vault.yaml` (canonical kinds/statuses/methodologies, empty scopes), the 11 built-in templates, and the `projects/`/`research/`/`notes/` domain dirs; the starter is a schema-typed constant serialized through the loader's own `yaml` stack, and `vault.yaml` is written last so an interrupted scaffold is never a loadable vault; a non-empty target is refused with its entries listed, an existing vault with `already a vault`; without `<dir>`, a `[y/N]` stderr prompt offers the current directory on a TTY, piped stdin keeps the usage error, `--yes` bypasses the prompt
- `vault.schema.json` — draft-07 JSON Schema emitted from the vault-spec module, written by `kmd init` beside `vault.yaml`; the generated `vault.yaml` opens with the yaml-language-server modeline for in-IDE validation and hover docs
- `kmd sync` refreshes `vault.schema.json` at the vault root when the running engine's emission differs (one stderr diagnostic)

### Changed

- the vault spec lives in one module — `@llm-wiki/db/vault-config` (schema, inferred types, `kindName`, `BUILT_IN_KINDS`, `loadVaultConfig`); the cli and mcp copies are removed
- **BREAKING** — `vault.yaml` parsing is strict: an unknown key at any level (root, scope entries, tags, triggers) fails the load loud; keys 0.6.0 silently ignored now refuse `sync`, `validate`, and MCP startup with the key named
- wiki-sdd adapters scaffold new vaults via `kmd init`; the bundled `assets/vault-templates/` snapshot is removed from all three

### Fixed

- `kmd hook <unknown-event>` degrades open — one stderr diagnostic, empty stdout, exit `0` — instead of exit `2`, which blocked and erased every prompt on Claude Code's UserPromptSubmit; bare `kmd hook` keeps the loud usage error
- `kmd <unknown-command>` with a hook event name in the argument tail degrades open the same way; a command typo with no event tail keeps the loud usage error

## [v0.6.0] - 2026-07-27

### Added

- `kmd hook prompt` — prompt-time trigger engine: triggers declared in `vault.yaml` (`triggers` full-replace per scope, `triggers_extra` additive, reserved `_all` key fires vault-wide); `keywords` match on word boundaries with porter stemming, `intent` regexes as escape hatch; one context line per new match, once per session (dedup state at `~/.kmd/state/hook/`)
- `kmd hook pretool` — deterministic tool gates: `tool`, `args_match` (regex over tool input), and `files` (globs against the paths the tool touches, relative to the event working directory) AND-compose; enforcement classes `inject` | `warn` | `block`; block-class gates exempt from session dedup
- `when` state predicates on pretool gates — `newer-than {fresh, than}` compares frontmatter `updated` across vault pages; an unmet precondition fires the gate, an unevaluable predicate skips with a diagnostic
- `kmd hook posttool` — auto validate + sync: a tool call that wrote inside the vault runs `kmd validate`; findings return as hook feedback and hold the sync; a clean write syncs the index silently; write detection covers `file_path`-style inputs and codex `apply_patch` envelopes
- `--harness claude` codec — Claude Code decision JSON for tool events (deny with reason, context injection, decision block on validation findings); neutral JSON contract without the flag
- `--harness kiro-ide` codec — prompt event read from Kiro IDE's `$USER_PROMPT` (Kiro writes nothing to stdin); session dedup keyed to a per-workspace 30-minute bucket (Kiro passes no session id)
- `--triggers <file>` — compiled trigger list (YAML/JSON) as an additive source; file triggers fire without an active scope
- scope resolution from the event working directory against `scopes.*.repo` (longest declared path wins, `~` expands); precedence: `--scope` > `$WIKI_SCOPE` > repo match
- hook exit-code carve-out: hook events exit `0` on every path; a degraded engine (missing or invalid config, bad payload, unreadable trigger file) emits one stderr diagnostic and never blocks a prompt or denies unrelated tool calls
- wiki-sdd plugins (claude, codex): prompt, pretool, and posttool events registered through a resolver wrapper that runs a `>= 0.6.0` global `kmd` in-process and falls back to `npx @bartolli/kmd@latest`

## [v0.5.1] - 2026-07-25

### Fixed

- FTS5 ranking weights title 10×, summary 5×, body 1× — pages naming a concept rank above pages that merely mention it
- `search` and `prime` share `FTS_RANK` constant for consistent ranking policy

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
