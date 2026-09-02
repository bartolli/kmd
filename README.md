# kmd — knowledge-markdown

kmd is a knowledge system for AI agents, built on [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) primitives: plain markdown, YAML frontmatter, a controlled vocabulary. What it adds is timing. The right context reaches the agent at the right moment, and costs nothing the rest of the time.

A cold session gets its orientation in one `prime` call: current focus, invariants, what to read. `search` returns ranked candidates, never page dumps. Hooks steer the agent at the exact event where a rule applies: a reminder on the prompt that needs it, a gate on the tool call that would break it, validation on the write that touched the vault. Rules that would otherwise sit in instruction files, paying tokens on every request, fire only when they matter.

The vault stays plain markdown in git, Obsidian-compatible. Works with Claude Code, Codex, and Kiro. No database to run.

```bash
npx @bartolli/kmd --help
```

## Quick start

Two setups. Pick one, or use both; they compose.

**A global vault.** One personal wiki serving all your projects:

```bash
npx @bartolli/kmd init ~/wiki-vault --set-default
```

`--set-default` records the vault in `~/.kmd/config.yaml`. Every `kmd` command and MCP server on this machine now finds it without configuration.

**A project vault.** The repo carries its own knowledge:

```bash
cd my-repo
npx @bartolli/kmd init --local
```

This scaffolds `my-repo/vault/` plus a `.kmd/` state home. Every command run inside the repo resolves this vault automatically, and it wins over the global default. Nothing else to configure.

Then, either way:

```bash
kmd validate   # deterministic checker, no LLM
kmd sync       # vault → SQLite index
```

## Where things live

| Thing | Where | Nature |
|---|---|---|
| Vault | wherever you put it (`~/wiki-vault`, `<repo>/vault/`) | yours: markdown + `vault.yaml`, git-tracked, canonical |
| Index | `~/.kmd/db/{vault-key}/index.db`, or `<repo>/.kmd/db/` for project vaults | disposable: `kmd db reset` deletes it, `kmd sync` rebuilds it |
| Machine config | `~/.kmd/config.yaml` | `default_vault`, written by `kmd init --set-default` or `kmd config set` |
| Project config | `<repo>/.kmd/config.yaml` | committed, repo-relative paths; `.kmd/config.local.yaml` is the personal, gitignored override |
| Hook state | `~/.kmd/state/` or `<repo>/.kmd/state/` | session dedup markers; survives `kmd db reset` |

A project vault's index and state live in the repo. Delete the repo and they go with it.

## How kmd finds your vault

One resolution order, used by the CLI, the MCP server, and the hooks. First hit wins:

1. An explicit path argument: pins that vault, beats everything.
2. The project: nearest ancestor with `.kmd/config.local.yaml`, `.kmd/config.yaml`, `vault/vault.yaml`, or a `vault.yaml` with a `.kmd/` directory beside it.
3. `--default-root <path>`: a configured default the project may beat.
4. `$WIKI_VAULT`.
5. `default_vault` from `~/.kmd/config.yaml`.

The project signal is the working directory: the shell's for CLI commands, the session's for hooks, `KMD_PROJECT_DIR` for MCP servers. When something resolves to the wrong vault, run `kmd config`. It prints the vault and which rank won.

Teams commit `.kmd/config.yaml` with a repo-relative `vault:` path or a `${VAR}` expansion. Absolute paths belong in the gitignored `config.local.yaml`.

## Commands

```
kmd init [<dir>] [-y] [--set-default]   scaffold a vault; --set-default records it as the machine default
kmd init --local [-y]                   project vault at <git-root>/vault/ with a .kmd/ state home
kmd validate [<path>]                   deterministic vault checker
kmd sync [<vault-root>]                 vault → SQLite index (validates first, aborts on errors)
kmd mcp [<vault-root>] [--default-root <path>]
                                        stdio MCP server
kmd config [<vault-root>]               print resolved vault, index path, winning rank
kmd config <set|get|unset> default_vault [<path>]
kmd db reset [<vault-root>]             delete the vault's index
kmd resource <uri> [<vault-root>]       print wiki://authoring, wiki://templates, or wiki://template/{domain}/{kind}
kmd prime <scope> [<vault-root>] [--task <text>]
kmd search <query> [<vault-root>] [--scope <s>] [--kind <k>] [--limit <n>]
                                        CLI mirrors of the MCP surface, for harnesses that read no resources
kmd hook <prompt|pretool|posttool|stop|session-start> [--default-root <path>] [--scope <s>] [--harness <h>] [--explain|--dry-run]
                                        harness gate engine (see Hooks)
```

`kmd --help` is canonical for flags; this list names the surface.

## MCP server

Two tools, deliberately few:

- **`prime(scope, task?)`** returns an orientation briefing: identity, primer, active decision records, current plan, vocabulary, most-linked pages, recent activity, cross-scope links. Pass `task` and it adds the top-ranked relevant pages, weighted so a page naming the concept in its title outranks pages that merely mention it.
- **`search(query, scope?, kind?, limit?)`** returns ranked candidates `{path, title, kind, summary, score}`. Never page bodies; the agent opens files itself.

Templates are served as MCP resources at `wiki://template/{domain}/{kind}`, and the authoring guide at `wiki://authoring`.

All of it is also a CLI: `kmd prime <scope>`, `kmd search <query>`, and `kmd resource <uri>` run an in-process client of the same server, so a harness whose agent cannot read MCP resources (CoCo, Kiro) still reaches the authoring guide and templates from a shell.

Registration:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "npx",
      "args": ["-y", "@bartolli/kmd", "mcp", "--default-root", "/absolute/path/to/vault"]
    }
  }
}
```

`--default-root` keeps the resolution order live: a project that carries its own vault wins automatically. Passing the path as a bare positional instead pins that one vault unconditionally. Use it only when that is what you want.

## Skills

The `wiki-sdd` plugin ships nine skills: a complete spec-driven development loop that reads and writes the vault. Each is a slash command (`$name` on Codex):

| Skill | What it does |
|---|---|
| `/wiki` | wires a project to the wiki; local-vs-global vault setup; the hub for everything below |
| `/intent` | interview that sharpens intent and scaffolds a scope: index, primer, glossary, lazy ADRs |
| `/to-stories` | turns the working conversation into a thin plan plus user stories with Gherkin scenarios |
| `/triage` | moves stories through `needs-triage` → `ready-for-agent` / `ready-for-human` / `wontfix` |
| `/to-issues` | slices stories into vertical tracer bullets; mirrors to GitHub or GitLab when configured |
| `/tdd` | implements one `ready-for-agent` slice, red-green-refactor, and ticks its checkbox |
| `/retro` | three questions, any time drift is suspected; routes the answers into intents and story Decisions, never a story |
| `/handoff` | closes the session: status sweep on approval, Story Index reconcile, the primer under budget — gated on a fresh retro |
| `/to-triggers` | turns a prose rule into a tested vault trigger: you own the intent, it owns the regex |
| `/signal-dense` | canonical-vocabulary register for long agentic threads |

The working loop: `/intent` → `/to-stories` → `/triage` → `/to-issues` → `/tdd` per slice → `/retro` whenever drift is suspected → `/handoff` to close. `/wiki` is the on-ramp; `/to-triggers` joins whenever a rule proves it should be a gate. The same skills render for all three harnesses below.

## Harness integration

### Claude Code

The repo is a plugin marketplace. The [`wiki-sdd`](plugins/claude/wiki-sdd/README.md) plugin wires everything: the MCP server, all five hook events, and the [nine skills](#skills).

```bash
claude plugin marketplace add bartolli/kmd
claude plugin install wiki-sdd@kmd
```

Project vaults resolve automatically: the plugin passes the project directory to the server. No per-project files.

### Codex

```bash
codex plugin marketplace add bartolli/kmd
codex plugin add wiki-sdd@kmd
```

Hooks are project-aware out of the box. The MCP server needs one line of help, because Codex gives plugin MCP servers no workspace signal ([openai/codex#37903](https://github.com/openai/codex/issues/37903)). Add to your shell profile:

```zsh
codex() { KMD_PROJECT_DIR="$PWD" command codex "$@"; }
```

Now every Codex launch carries its project directory, and `prime`/`search` follow project vaults exactly as on Claude Code. Details: [codex adapter README](plugins/codex/wiki-sdd/README.md).

### Kiro

Kiro consumes the same skills as [Agent Skills](plugins/kiro/wiki-sdd/README.md). Copy the skill folders into `~/.kiro/skills/` or `.kiro/skills/`, and register the MCP server in `.kiro/settings/mcp.json` from the bundled template. Both Kiro seats (IDE and CLI) read the same layout.

### Manual wiring

No plugin, any harness that supports command hooks. Install globally first. Hooks spawn per event, and a global install keeps the spawn fast:

```bash
npm i -g @bartolli/kmd
```

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
        "command": "kmd hook prompt --default-root /absolute/path/to/vault" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command",
        "command": "kmd hook pretool --default-root /absolute/path/to/vault --harness claude" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|Bash",
        "hooks": [{ "type": "command",
        "command": "kmd hook posttool --default-root /absolute/path/to/vault --harness claude" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command",
        "command": "kmd hook stop --default-root /absolute/path/to/vault" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command",
        "command": "kmd hook session-start --default-root /absolute/path/to/vault" }] }
    ]
  }
}
```

`--harness claude` emits Claude Code's decision JSON on tool events. Without it the output is a neutral JSON contract. Kiro IDE wires the prompt event with `--harness kiro-ide`.

## Hooks

Rules in instruction files cost tokens on every request. A trigger costs nothing until the moment it applies, then delivers the whole rule. Triggers are declared in `vault.yaml`; `kmd hook` evaluates them when the harness fires an event.

Five events:

- **`prompt`**: matching triggers inject one context line each, once per session.
- **`pretool`**: gates before a tool runs: inject, warn, or deny with a reason the agent reads.
- **`posttool`**: after a write inside the vault, `kmd validate` runs; findings return to the agent and the index holds until they are fixed. Clean writes sync silently.
- **`stop`**: a session ending with validation errors is sent back once with the fix list.
- **`session-start`**: a session opening inside a scope's repo gets one orientation line: prime first.

```yaml
triggers_extra:
  my-app:
    - id: retro-before-tag
      on: pretool
      enforce: block
      tool: Bash
      args_match: "\\bgit tag\\b"
      when:                    # precondition: the gate fires only while it is unmet
        name: newer-than
        fresh: ["notes/my-app-retro-*.md"]
        than: ["projects/my-app/ops/release-*.md"]
      reason: "Retro gate: run the retro before tagging."
```

Prompt triggers match `keywords` with stemming on word boundaries; `intent` regexes are the escape hatch. Pretool matchers AND-compose: `tool` name, `args_match` regex, `files` globs. `when` predicates read your vault's files at call time. The example denies tagging until a retro note postdates the last release note.

You don't write this YAML by hand. The `/to-triggers` skill interviews your intent, authors the keyword and regex mechanics itself, proves fire and near-miss behavior with a dry run, and writes `vault.yaml` only after validation passes. You own the rule; it owns the regex.

Declare `repo:` on a scope and the engine resolves the active scope from the session's working directory:

```yaml
scopes:
  my-app:
    status: active
    repo: ~/Projects/my-app
```

Everything fails open. A broken config means one stderr line and no gate work: never a blocked prompt, never a denied unrelated call. Test triggers by hand with `kmd hook prompt --explain` (a read-only trace; never wire probe flags into hook registrations).

If other Node tooling in your agent loop prints `ExperimentalWarning` noise, set `NODE_OPTIONS="--disable-warning=ExperimentalWarning"` in the harness env.

## The vault

```
vault/
├── vault.yaml               # controlled vocabulary, the contract
├── templates/               # frontmatter templates, served as MCP resources
├── projects/{scope}/        # specs, ADRs, plans, stories
├── research/{topic}/        # articles, sources
└── notes/                   # low-ceremony capture
```

Every page carries YAML frontmatter validated against `vault.yaml`:

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

`kind` selects the template, `status` tracks lifecycle, and every value must appear in `vault.yaml` or validation fails. Loading is fail-loud: an invalid `vault.yaml` stops the server and blocks sync rather than serving drift.

`kmd validate` runs seventeen deterministic rules, no LLM involved. Among them: `dangling-link` (every `[[wikilink]]` resolves), `ambiguous-link` (a bare `[[name]]` owned by two files must disambiguate), `supersession-reciprocal` (an ADR superseding another requires the back-pointer), `path-authority` (the path, not frontmatter, decides scope and topic), and `tag-alias` (aliases normalize to canonical tags). Sync refuses to index a vault with errors.

`vault.yaml` also carries the served pedagogy: the authoring rules agents read at `wiki://authoring`, custom kinds with their own templates, your methodologies, and the trigger declarations. The full reference with every field and customization pattern: [docs/vault-config.md](docs/vault-config.md). A complete annotated example: [`vault.yaml.example`](vault.yaml.example).

## kmd vs OKF

Same primitives as [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) (markdown, YAML frontmatter, a directory tree), but opinionated where OKF is minimal:

| | OKF | kmd |
|---|---|---|
| Vocabulary | open: producer picks `type` values | controlled: `vault.yaml` defines kinds, scopes, statuses, tags; `kmd validate` enforces |
| Structure | flat: organize however | three domains: `projects/` · `research/` · `notes/` |
| Validation | none: format spec only | seventeen deterministic rules, LLM-free; gates sync |
| Cross-refs | bundle-relative `/path.md` | `[[wikilinks]]`: Obsidian-native, rename-safe, no dangling links |
| Agent surface | none | two MCP tools (`prime`, `search`) + template resources |
| Guardrails | none | prompt reminders and tool gates from `vault.yaml` |
| Infrastructure | n/a | `node:sqlite` FTS5, zero external services |

## Development

Node.js 22+ (`node:sqlite`) and pnpm 11+.

```bash
pnpm install
pnpm -r run typecheck && pnpm -r run test && pnpm lint
```

The plugin adapters under `plugins/{claude,codex,kiro}` are build output. Edit the shared source in `plugins/src/wiki-sdd/`, then render and verify:

```bash
pnpm --filter @llm-wiki/render render && pnpm --filter @llm-wiki/render check
```

A hand-edited adapter copy diverges silently until the next render overwrites it. `check` asserts every copy matches the rendered output.

## License

MIT
