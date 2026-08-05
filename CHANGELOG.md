## [v0.11.0] - 2026-08-04

### Added

- `kmd hook session-start` — fifth hook event: a session starting inside a declared scope repo receives one stdout context line — the prime instruction (`orient`), or the post-compaction re-orientation (`reorient`) when the payload carries `source: "compact"`; no resolved scope means silence, no dedup state is read or written, fails open and exits 0
- `builtin_hooks` ids `orient` and `reorient` (`text` only, strict) — the engine owns the scope binding (`Wiki scope "{scope}": …`), config owns the instruction prose

### Changed

- claude and codex adapters register SessionStart matcher-less; the engine branches on `source`. Codex delivers SessionStart stdout as developer context with the same source vocabulary and re-fires SessionStart with `source: "compact"` after compaction, mid-turn included (verified live on 0.146.0 plus the codex hooks doc); codex subagent sessions are excluded upstream. PreCompact/PostCompact stdout is not a context channel on either harness
- wrapper `MIN_HOOK_VERSION` floor: `[0, 11, 0]` — globals below it take the `npx @latest` fallback on every hook event until upgraded
- retro skill: the file-vs-fix-now override (retro authorizes artifacts, never fixes; four preconditions gate acting at hot momentum) and the story status sweep — all-resolved stories are proposed for `status: archived` at retro, operator approval required, verification debt named as a hold argument

## [v0.10.0] - 2026-08-04

### Added

- `kmd hook <prompt|pretool> --explain` — one neutral JSON trace per synthetic event: resolved scope, duplicate ids, and per trigger the matcher verdict (`hit` or the missed stage — `tool-miss`/`args-miss`/`files-miss`/`payload-miss`; prompt triggers carry `keywords`/`intent` evidence instead), typed predicate evidence (`satisfied`/`unmet`/`vacuous`/`unknown` — explain-only vocabulary; enforcement keeps the locked tri-state), the dedup verdict (`exempt`/`never`/`fresh`/`suppressed`), `fired`, and the outcome the harness would receive under the selected codec. Explain reads dedup state and never writes it; `--dry-run` runs the live contract without state writes. Posttool and stop decline both flags with one diagnostic and do nothing — a probe never syncs the index or spends handoff state
- posttool vault-touch detection reads shell `command` strings: quote-aware tokens count on a path separator, a glob or variable character, a bare dot, or a vault content extension; relative tokens resolve against the event `cwd`, so glob and variable targets register only inside the vault. `rm`, `mv`, `sed -i`, redirections, and `rm *`-class deletions reach the resync; the claude and codex adapters bind `Bash` in their PostToolUse matchers

### Changed

- dedup state is one atomic marker file per fired key under `$KMD_HOME/state/hook/{session_id}/` — concurrent events add keys, never erase each other's; persistence is best-effort: a state IO failure emits one stderr diagnostic and never suppresses a matched deny, inject, or handoff-gate block. Legacy `{session_id}.json` state is ignored, not migrated — an in-flight session re-fires each deduped reminder once after upgrade
- renderers separate trigger identity from rendered payload: each matched id spends its own dedup key, byte-identical inject/warn text renders once, and every unique block reason reports in match order — on both codecs and the prompt event's stdout lines
- `kmd sync` orphan sweep runs on a zero-page walk: with `vault.yaml` loaded, an empty vault sweeps the index empty instead of retaining orphans; the mis-mount case never reaches the sweep because config load fails loud first
- `/to-triggers` dry-run loop runs `--explain` and reads the trace as the only fire signal

### Fixed

- shell mutations inside the vault no longer leave MCP retrieval stale — the PostToolUse surface was tool-name-bound to `Edit`/`Write`/`apply_patch`, so a shell `rm` never reached the resync
- an unwritable dedup state directory no longer suppresses a matched pretool deny in mixed block+inject events, a prompt inject, or the stop handoff-gate — dedup persistence ran inside the decision path and its exception erased already-matched output

## [v0.9.0] - 2026-08-01

### Added

- `builtin_hooks` — `vault.yaml` section addressing the fixed-function hooks' prose by public id: `resync` (posttool validate + sync) takes `reason` (validate-errors preamble) and `text` (sync-failed note); `handoff-gate` (stop) takes `reason`. Strict per id — an unknown id or a field an id does not take fails the load. Absent entries fall back to the engine defaults; the configurable string is a preamble and the engine appends the error lines itself
- fixed-function hooks carry public ids: `resync` and `handoff-gate`; the stop gate's session-state dedup key is `handoff-gate`

### Changed

- posttool errors preamble default: `Edit landed; the index sync is held until these validate errors are fixed` — the write lands, the sync is what is held; the stop preamble is count-free
- pretool `files` globs match `*** Add|Update|Delete File:` paths inside apply_patch envelopes, as the posttool vault-write guard already did
- codex adapter registers PreToolUse with `--harness claude` — codex emits claude-canonical pretool payloads (verified live on 0.146.0: the shell tool arrives as `tool_name: "Bash"` with a string `command`; edits as `apply_patch` envelopes), so `tool: Bash` gates and their `args_match` regexes fire unmodified
- wrapper `MIN_HOOK_VERSION` floor: `[0, 9, 0]` — globals below it take the `npx @latest` fallback on every hook event until upgraded
- kiro README documents both wirable kiro hooks: CLI `userPromptSubmit` + `stop` in agent configuration; IDE prompt via `--harness kiro-ide`

## [v0.8.0] - 2026-07-30

### Added

- `kmd hook stop` — handoff gate: a stop event whose `cwd` resolves to a declared scope repo, while the vault holds validate errors, returns `{"decision": "block", "reason": <error lines>}` on stdout and sends the agent back; warnings never block. Guards: `stop_hook_active: true` short-circuits; engine dedup blocks at most once per `session_id`, the token spent only when a block renders; no resolved scope → no output. One output codec serves Claude Code, Codex, and kiro-cli Stop hooks. Fails open and exits `0` on every path like the other hook events
- trigger `dedup` field — per-trigger re-fire policy for inject/warn: `session` (default, once per session), `never` (every match, no state spent), `{minutes: N}` (once per bucket within a session, fired record keyed `id@bucket`); `dedup` on a block trigger fails the `vault.yaml` load — blocks fire on every matching event

### Changed

- claude and codex adapters register a `Stop` hook invoking `kmd hook stop`; the resolver wrapper's `MIN_HOOK_VERSION` floor is `[0, 8, 0]` — globals below it take the `npx @latest` fallback on every hook event until upgraded
- kiro adapter ships a README: install path for the nine skills (repo clone + copy, or per-folder IDE import), MCP registration from the bundled template, and stop-hook wiring via agent-config `hooks.stop` — the first kiro-wirable hook; pretool and posttool stay unwired on kiro
- `/to-triggers` noise-budget pedagogy covers the `dedup` policy field and the shared-budget hazard: broad keywords and a sharp intent regex on one trigger id share one dedup budget

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
