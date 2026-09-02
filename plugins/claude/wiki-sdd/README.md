# wiki-sdd

Wiki-native spec-driven development loop for the `~/llm-wiki` agent wiki.

## Skills

| Skill | Role |
|---|---|
| `wiki` | Bootstrap a project into the agent wiki; on-ramp for the constellation. |
| `intent` | Interview intent into `spec-context.md` + scaffold scope, or write one idea as an intent. |
| `to-stories` | Stories from a conversation (plan + per-story files) or from a promoted intent (one story). |
| `triage` | Move stories through the triage state machine. |
| `to-issues` | Slice stories into tracker issues. |
| `tdd` | Implement a ready-for-agent slice via red-green-refactor. |
| `retro` | Three-question grooming step, any time drift is suspected; answers become intents and story Decisions, never a story. |
| `handoff` | Session close: status sweep on approval, Story Index reconcile, primer under budget — gated on a fresh retro. |
| `to-triggers` | Author vault gate triggers from stated intent; dry-run tested, approval-gated. |
| `signal-dense` | Canonical-vocabulary response register for long agentic threads. |

Arc: `/intent` → `/to-stories` → `/triage` → `/to-issues` → `/tdd` → `/retro` whenever drift is suspected → `/handoff` to close.

`signal-dense` and `/to-triggers` sit outside the arc: invoke `signal-dense` before authoring specs, ADRs, and blueprints so wiki artifacts are written in canonical vocabulary rather than drafted loose from memory; invoke `/to-triggers` whenever a rule should become a gate — it interviews intent, authors the matching, and writes `vault.yaml` only after a dry-run proves fire and near-miss behavior.

## MCP server

Ships `.mcp.json` registering the `wiki` stdio server (`prime`, `search` tools) via `npx @bartolli/kmd`; on install the plugin asks for your vault path (`vault_path` user config). That path is the *default*: a project carrying its own vault — a co-located `vault/vault.yaml`, a `.kmd`-marked root vault, or a committed `.kmd/config.yaml` — resolves ahead of it automatically, so `prime`, `search`, and `wiki://` resources serve the project's vault with no per-project registration. If the `wiki` server is also registered globally in `~/.mcp.json`, remove the global entry when enabling this plugin to avoid double registration.

## Gate hooks

Registers the `kmd hook` gate engine on three events — no manual wiring:

- **UserPromptSubmit** — prompt-time reminders from your vault's `triggers_extra` (`vault.yaml`), injected once per session per trigger.
- **PreToolUse** — vault-declared gates on tool calls: deny with a reason, warn, or inject context, including state-aware preconditions (`when: newer-than`).
- **PostToolUse** — auto validate + sync: after a mutation inside the vault — an `Edit`/`Write`, or a shell command (`Bash`) whose string names a vault path, including `rm`, `mv`, redirections, and glob deletions — `kmd validate` runs; findings return into the session for the agent to fix and the index holds until they are; a clean write syncs silently. Tool calls outside the vault cost nothing.

Scope resolves from the session's working directory when your `vault.yaml` scopes declare `repo:`; a project can override with `WIKI_SCOPE` in its settings `env`.

**Per-project vaults resolve automatically.** Hooks and the MCP server run the same engine resolution chain: a project carrying its own vault — a co-located `vault/vault.yaml`, a `.kmd`-marked root vault, or a committed `.kmd/config.yaml` (`kmd init --local` scaffolds the full shape) — binds ahead of the configured `vault_path`, per event from the event's working directory. No per-project files or shadow registrations; earlier `.claude/wiki-sdd.local.md` overrides are retired and ignored — delete them, the engine resolution replaces the mechanism. The hooks run through a resolver wrapper: a globally installed `kmd` at `0.12.0`+ runs in-process (fast path — `npm i -g @bartolli/kmd` recommended), else `npx @bartolli/kmd@latest`. A missing or invalid trigger config degrades to a no-op with one stderr diagnostic — gates never block unrelated work.

**Never wire `--explain` or `--dry-run` into hook registrations.** They are probe flags for testing triggers by hand (`/to-triggers` uses them): explain output carries no enforcement decision, so a hook registered with either flag silently stops denying anything.

## Recommended companion

`obsidian-vault` — vault file-format skills (Obsidian Flavored Markdown, Bases, JSON Canvas, Obsidian CLI). The SDD loop writes vault files; `obsidian-vault` handles their format. Enable both in agent-wiki projects.
