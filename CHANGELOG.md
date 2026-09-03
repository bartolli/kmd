## [v0.16.0] - 2026-09-03

### Added

- `glossary` is a built-in kind at `projects/{scope}/glossary.md` — the scope's vocabulary beside the index and the primer; the validate floor requires `title`, `kind`, `scope`, `status`, `summary`, `updated`; the folder pattern binds it to the scope root; a kind-selector row teaches it; `project-glossary.md` ships in the starter with four sections — Language, Relationships, Example dialogue, Flagged ambiguities — and is served at `wiki://template/project/glossary`. `kmd init --upgrade` reports the kind and the template on an older vault and `--apply` writes both
- `prime` and `kmd prime` carry the glossary's Language section verbatim under `Vocabulary`, after the vault's kinds, statuses, and tags; no section and no warning when the scope has no glossary; `spec/spec-context.md` is never inlined, with or without a glossary beside it. `PrimeData.glossary`; `languageSection` exported from the prime module
- `kmd hook session-start --defer-orientation` holds the rendered orientation as a pending marker in the session's hook state dir and prints the envelope as before; `kmd hook prompt` prints a pending marker first, plain, once, ahead of any trigger line, on every harness; the `source: "compact"` re-fire holds the re-orientation the same way; `--dry-run` and `--explain` leave a marker in place. Without the flag nothing is held and prompt output is unchanged

### Changed

- the authoring rule for the primer and the primer template name `glossary.md` handles where they named `spec-context`
- wiki-sdd 0.20.0: every skill reads and writes `projects/<scope>/glossary.md` and no skill source names `spec-context`; the `intent` skill's Step 3 creates the glossary from `wiki://template/project/glossary` at the scope root, the Language section the term list alone; plan References link `[[glossary]]`; adapter READMEs and manifest descriptions say glossary. Render lock: no skill source names `spec-context`; the intent skill names the glossary template and path, never the spec template
- the cortex manifest's SessionStart command carries `--defer-orientation`, locked by a render test to that event alone; the coco README's gate-hooks section states the route
- wrapper floor `MIN_HOOK_VERSION` `[0, 16, 0]` in the shared claude/codex wrapper and the coco chrome, paired with this engine; plugin stamps 0.20.0

### Fixed

- Cortex Code sessions receive the wiki orientation and the post-compaction re-orientation. Cortex runs SessionStart hooks at startup before the agent connects and shows their output without delivering it, while UserPromptSubmit injects plugin-hook stdout in either shape; the deferred marker rides the first prompt. Witnessed on Cortex Code CLI v1.1.78

## [v0.15.1] - 2026-09-02

### Fixed

- `kmd hook session-start` prints one line of JSON — `hookSpecificOutput.hookEventName` `SessionStart`, `additionalContext` the orientation line — instead of the bare line. Claude Code and Codex inject plain stdout and the envelope alike. Correction after the tag: Cortex Code runs SessionStart hooks at startup before the agent connects and shows their output without delivering it, envelope or plain, so on that harness the orientation still does not reach the agent; the coco route is open. `sessionStartStdout` is exported from the hook module
- wiki-sdd 0.19.1: the `intent` skill's greenfield primer stub, its termination check, and its refine step name `Focus`, `Next`, `Open`, `Read order` — the shape `wiki://template/project/primer` serves and `/handoff` rewrites — where they had kept the six-section shape; the stub's clocks are quoted UTC timestamps. A test asserts no skill source names a six-section heading

### Changed

- the codex adapter README lists the SessionStart hook and its `source: "compact"` re-fire beside the other events

## [v0.15.0] - 2026-09-02

### Added

- `kmd init --upgrade [<vault-root>] [--apply]` — the additive delta between a resolved vault and the engine's starter: missing kinds, statuses, methodologies, template files, domain dirs. Bare prints the report and exits 1 when behind, 0 when current; a template present but differing from the starter prints as `differs (kept)` and never moves the exit code. `--apply` writes the delta and exits 0 — templates byte-identical to the starter and domain dirs first, `vault.schema.json` refreshed, `vault.yaml` last through the yaml Document API with no line folding and no flow padding, so comments and the modeline survive and a block or single-line flow sequence round-trips byte-identical (a multi-line flow sequence is re-laid out on one line, semantics unchanged); idempotent, no prompt; `scopes`, `tags`, `triggers_extra`, `builtin_hooks`, and existing template bodies are never touched. `--apply` without `--upgrade` is a usage error, exit 2. Resolution is the operator-command chain: positional > project tier > `$WIKI_VAULT` > global `default_vault`
- the session-start orientation ends with `Vault behind the starter: <counts> — kmd init --upgrade.` when the vault's additive delta is non-empty; absent when current and after compaction; the hook exits 0 either way
- `@llm-wiki/cli/upgrade`: `diffVault`, `applyVaultDelta`, `upgradeVault`, `summarizeDelta`
- wiki-sdd `wiki` hub, Process step `Existing vault: bring it to the starter` between MCP detection and the project-instructions write: run the report, show it verbatim, `--apply` on approval; CLI route only, no kind or template named in prose

### Changed

- the starter lists every built-in kind — `artifact`, `prompt`, and `intent` included — and a test binds `STARTER_CONFIG.kinds` to `BUILT_IN_KINDS`
- `template file missing` ends with `— run kmd init --upgrade` for a starter template; a custom kind's missing template keeps the bare error
- wrapper floor `MIN_HOOK_VERSION` `[0, 15, 0]` in the shared claude/codex wrapper and the coco chrome, paired with this engine; plugin stamps 0.19.0. The 0.18.0 train paired `[0, 14, 0]` with engine 0.14.0 and delivered the loop skills

### Fixed

- a vault scaffolded by `kmd init` validates an intent: `intent` was in `BUILT_IN_KINDS` and the template set but not the starter's `kinds`, so every fresh vault rejected its first intent with `kind-vocabulary`
- the `to-stories` skill description lists `/to-stories` once; the rename had folded `/to-prd` into a repeated token

## [v0.14.0] - 2026-09-02

### Added

- `intent` is a built-in kind at `projects/{scope}/intent/intent-{slug}.md`; the validate floor requires `origin` and `sightings`; served at `wiki://template/project/intent` with a kind-selector row, and `kmd init` ships the template
- `created` and `updated` are quoted UTC timestamps `YYYY-MM-DDTHH:MM:SSZ` taken from the clock; validate rules `timestamp-format`, `timestamp-order`, `timestamp-skew` (five minutes against the seat clock), all errors; date-only values stay legal as coarse clocks; `validatePage` accepts `{ now }`
- sync warning `updated-not-advanced`: content changed under an unchanged clock; the posttool hook surfaces sync warnings beside validate findings
- scoped notes: any `notes/` folder segment implies `kind: note`, so `projects/{scope}/notes/` is a note home beside the root `notes/` domain; `wiki://template/project/note` serves the note template beside `wiki://template/note`
- session-start orientation carries the backlog band, read from frontmatter: stale AFK stories (`ready-for-agent`, `active`, zero ticked slices, `updated` thirty days behind) and draft intents; silent when empty, absent after compaction
- `LocalClient.listTools()` lists the served tools
- wiki-sdd `handoff` closes the session: the primer is the first write after a retro note newer than the scope's last edit, then the status sweep on approval, the Story Index reconcile, the sync check, and one line naming what the next session starts with; the primer is four sections, about 300 words, in the `signal-dense` register
- wiki-sdd `intent` (was `grill-with-docs`) writes a sharpened idea as an `origin: user` intent; `to-stories` (was `to-prd`) elaborates a promoted intent into one story under the active plan; both keep their prior trigger phrases

### Changed

- sync indexes `updated` as written
- the search tool description names `wiki://authoring`, `wiki://templates`, and `kmd resource` as the authoring-protocol route
- the authoring guide carries the primer contract (Focus, Next, Open, Read order; about 300 words; `signal-dense` register), both note homes, and the clock command; the plan template has no Status Log section
- wiki-sdd `retro` is a grooming step invocable at any point: three questions, the third a re-read of the slice in progress with every detour classified decision, drift, or done; answers route to intents (at most three per run), sightings bumps, story Decisions entries, and a ten-line section in the scope's dated note, never a story, never the primer; the hot-path override admits a committed failing test as the shape lock for a one-slice fix
- wiki-sdd `triage` reads state from the vault filesystem; draft intents by sightings lead the buckets, the stale band offers demote, dismiss, or keep, and an intent is promoted, held, dismissed, or merged; `adr-no-*` is reserved for design rejections
- the hub skill, the project-instructions template, the root README, `AGENTS.md`, and the four adapter READMEs name `/handoff` as the session close and the loop `intent → to-stories → triage → to-issues → tdd → retro → handoff`; the hub description no longer enumerates its siblings
- render manifest: `intent`, `to-stories`, and `handoff` in the rendered set

### Fixed

- the codex and coco slash rewrite leaves a name followed by `/` untouched: `{scope}/intent/` is a path, `/intent` an invocation

## [v0.13.0] - 2026-09-01

### Added

- `kmd resource <uri> [<vault-root>]`, `kmd prime <scope> [<vault-root>] [--task <text>]`, `kmd search <query> [<vault-root>] [--scope <s>] [--kind <k>] [--limit <n>]` — CLI mirrors of the MCP surface, an in-process client of the same server (the `McpServer` `kmd mcp` builds, an SDK `Client`, an in-memory transport between them; resolved binding, 2025 handshake): the handlers, validation, and error shapes the agent reaches, no second process. `resource` serves `wiki://authoring`, `wiki://templates`, and `wiki://template/{domain}/{kind}` for harnesses whose agents cannot read MCP resources (CoCo, Kiro). Exit codes: an unknown URI or a missing positional exits 2; a tool `isError` result exits 1 with `code: message` on stderr. The two-tool MCP freeze holds — a client is not a tool
- `@llm-wiki/mcp/local`: `openLocalClient`, `runResource`, `runTool`; the CLI path logs to stderr only, synchronously
- bundle version stamp: the `dist/kmd.mjs` head reads hashbang, then `// kmd-version=<version>`; `kmd --version` reports it (unbundled runs read `package.json`); the hook resolver reads the stamp ahead of `package.json`, so a source-linked install that pulled without rebuilding fails the floor loudly instead of running the old bundle

### Changed

- hook resolver (shared claude/codex wrapper, coco wrapper): three tiers, cheapest first — import (npm's symlink at `kmd.mjs`, or a pnpm shim's target read from its `cmd-shim-target` trailer (pnpm 11) or `$basedir` exec line (pnpm 10)); version-probed spawn for any other executable (`--version` asked before stdin is touched; the spawn is terminal — a non-zero exit is one stderr line and exit 0); npx `@bartolli/kmd@latest` on claude and codex only. The PATH scan never stops early, a candidate is a regular executable file, and the first below-floor entry is named in the fallback diagnostic. `MIN_HOOK_VERSION` `[0, 12, 1]` in both wrappers
- coco wrapper: same resolution, no npx, exit 0 on every path; a stale or missing engine is one stderr line naming path and version. The bundle's npx-free invariant test bans the npx target, not `child_process` — the bundle already spawns `kmd mcp`
- pedagogy names both routes: skill bodies, the project-instructions template, `AGENTS.md`, the `prime` tool's authoring hint, and the session-start orientation carry `kmd prime <scope>` / `kmd search <query>` / `kmd resource <uri>` beside the MCP form
- toolchain floor: root `packageManager` pnpm 10.33.0 (corepack hash), `engines.pnpm` `>=10.0.0`; the lockfile (9.0) resolves unchanged under pnpm 10
- README: the command list and the MCP section carry the CLI mirrors

### Fixed

- a shell-shim `kmd` on PATH (pnpm, Volta) no longer disables the gate hooks: the wrapper rejected any realpath without a node extension and stopped scanning — on coco every gate was silently off; on claude and codex every event fell to npx, and behind a registry without `kmd`, to nothing

## [v0.12.1] - 2026-09-01

### Added

- coco (Cortex Code) adapter: the repo root carries `.cortex-plugin/plugin.json` — skills by path into `plugins/coco/wiki-sdd`, hooks and `mcpServers` inline; `.cortex-plugin` outranks `.claude-plugin` at manifest resolution, so the Claude marketplace manifest stays claude-only. The flavor dir carries components, not a plugin: rendered skills and an npx-free resolver that imports a global `kmd` ≥0.12.0 in-process and exits 0 on a missing prerequisite. Install routes: `cortex plugin install bartolli/kmd`, `--plugin-dir`, a `.cortex/plugins/` symlink, or the settings `plugins` array
- coco render dialect: `$name` invocation like codex, bare Claude → CoCo; CoCo reads `CLAUDE.md` as a project-instructions file, so the CLAUDE.md-survival lint exempts the identity and coco dialects
- the wiki skill's harness guidance carries a CoCo column: skill/MCP placement under `~/.snowflake/cortex`, launch-dir project signal, the `UNKNOWN_SCOPE` route

### Fixed

- pretool trigger `tool:` matches the runtime tool id case-insensitively — `tool: Bash` fires on claude's `Bash` and CoCo's lowercase `bash` alike; the compare stays deterministic (no harness carries two tools differing only by case)
- `AGENTS.md` is a real tracked file; a fresh clone carried a dangling symlink to the untracked `CLAUDE.md`, which aborts `cortex plugin install` at manifest discovery

## [v0.12.0] - 2026-08-10

### Added

- two-tier project-aware vault resolution — one chain for every entry point (bare CLI, MCP server, hooks): positional > project tier (`.kmd/config.local.yaml` > `.kmd/config.yaml` > `vault/vault.yaml` > `vault.yaml` with a `.kmd` sibling, nearest ancestor of the project signal) > `--default-root` > `$WIKI_VAULT` > global `default_vault`. Project signal: MCP `KMD_PROJECT_DIR` ?? client roots; hooks the event-payload `cwd`; bare CLI the process cwd. The engine reads no harness-named variable — adapters map their tokens in chrome
- global config `~/.kmd/config.yaml` (`default_vault`) with `kmd config set|get|unset` (comment-preserving writes); project tier: committed `.kmd/config.yaml` carries repo-relative paths or `${VAR}`/`${VAR:-default}` expansions, gitignored `config.local.yaml` carries personal absolutes and wins. Unresolvable `${VAR}`: loud on operator commands, degrade-open on hooks
- `kmd init --local` — project vault at `<git-root>/vault/` plus `.kmd/` state home with a `.gitignore` covering `db/`, `state/`, `config.local.yaml`; `kmd init --set-default` — the only non-interactive route to writing `default_vault`
- `kmd mcp --default-root <path>` and `kmd hook <event> --default-root <path>` — the plugin invocation form: a config default the project tier may beat; the positional stays authoritative (mcp: mutual exclusion is a usage error, exit 2; hooks: the positional wins with one diagnostic)
- tier-homed state: a vault beside a `.kmd/` directory homes its index at `<that>/db/index.db` and hook dedup state at `<that>/state/hook` — living and dying with the repo; `kmd db reset` touches neither config nor state at either tier
- `kmd sync` gains the vault-root positional; `kmd config` prints the winning chain rank as `source:`
- MCP roots-sourced deferred binding — with no positional and no `KMD_PROJECT_DIR`, the vault binds after initialization from the client's `roots/list` through the same tier walk, fail-loud at bind time; transitional: MCP spec revision 2026-07-28 deprecates Roots — the path serves handshake-protocol clients through the deprecation window and is removed, not migrated, when the SDK crosses that revision

### Changed

- resolution inside a vault-carrying project: the project tier beats `$WIKI_VAULT` for bare invocations — this is the feature; the explicit positional is the escape hatch
- bare root-layout `vault.yaml` binds by convention only in `.kmd`-marked directories; a skipped unmarked candidate gets one stderr notice on operator commands (naming the `mkdir .kmd` fix) and silence on the hook path — hook stderr is the degradation channel
- `init -y` answers scaffold confirmations only — `kmd init <dir> -y` never writes the machine `default_vault`
- claude adapter: `.mcp.json` launches `kmd mcp --default-root ${user_config.vault_path}` with `env.KMD_PROJECT_DIR = "${CLAUDE_PROJECT_DIR}"`; `hooks.json` passes `--default-root`; per-project vaults resolve with no per-project files — the `.claude/wiki-sdd.local.md` hook override and `claude-project-override.mjs` are removed
- codex adapter: `hooks.json` passes `--default-root` (hooks are project-aware from the payload `cwd`); the MCP launcher passes `--default-root` and `.mcp.json` whitelists `KMD_PROJECT_DIR` — codex ≤0.146.0 provides plugin MCP servers no workspace signal (plugin-cache cwd, no root token, no roots capability), so per-project `prime`/`search` needs the export in the launching shell (openai/codex#37903)
- wrapper `MIN_HOOK_VERSION` floor: `[0, 12, 0]` — pre-chain globals take the npx fallback; a pre-chain engine reached via npx degrades the new hook args to the configured-vault behavior
- plugin surfaces at 0.16.0 (claude, codex, marketplace)

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
