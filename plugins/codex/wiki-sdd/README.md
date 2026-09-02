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

Arc: `$intent` → `$to-stories` → `$triage` → `$to-issues` → `$tdd` → `$retro` whenever drift is suspected → `$handoff` to close.

`signal-dense` and `$to-triggers` sit outside the arc: invoke `signal-dense` before authoring specs, ADRs, and blueprints so wiki artifacts are written in canonical vocabulary rather than drafted loose from memory; invoke `$to-triggers` whenever a rule should become a gate — it interviews intent, authors the matching, and writes `vault.yaml` only after a dry-run proves fire and near-miss behavior.

## MCP server

Ships `.mcp.json` registering the `wiki` stdio server (`prime`, `search` tools) via `npx @bartolli/kmd`. The launcher passes `--default-root` (from `WIKI_VAULT`, falling back to `~/llm-wiki/vault`), so the engine's full resolution chain stays live; set `WIKI_MCP_LOG_LEVEL` to override the default `info` log level. If the `wiki` server is also registered globally, remove the global entry when enabling this plugin to avoid double registration.

**Per-project vaults.** Gate hooks are project-aware automatically — every hook event carries the session working directory, and a project carrying its own vault (co-located `vault/vault.yaml`, `.kmd`-marked root vault, or committed `.kmd/config.yaml`) resolves ahead of the configured default. The MCP server cannot see the workspace on its own (codex ≤ 0.146.0 launches plugin MCP servers in the plugin cache directory with no workspace signal and no `roots` capability), so per-project `prime`/`search` needs an explicit export in the shell that launches codex: `export KMD_PROJECT_DIR="$PWD"` engages the same chain, or `WIKI_VAULT` pins the vault directly. Both pass through the plugin's `env_vars` whitelist.

## Gate hooks

Registers the `kmd hook` gate engine — no manual wiring:

- **UserPromptSubmit** — prompt-time reminders from your vault's `triggers_extra` (`vault.yaml`), injected once per session per trigger.
- **PostToolUse** — auto validate + sync: after a mutation inside the vault — an `apply_patch` edit, or a shell command whose string names a vault path, including `rm`, `mv`, redirections, and glob deletions — `kmd validate` runs; findings return into the session for the agent to fix and the index holds until they are; a clean write syncs silently. Tool calls outside the vault cost nothing.

The hooks run through a resolver wrapper: a globally installed `kmd` at `0.7.0`+ runs in-process (fast path — `npm i -g @bartolli/kmd` recommended), else `npx @bartolli/kmd@latest`. A missing or invalid trigger config degrades to a no-op with one stderr diagnostic — gates never block unrelated work. Review and trust the hooks with `/hooks` after installing the plugin.

**Never wire `--explain` or `--dry-run` into hook registrations.** They are probe flags for testing triggers by hand (`$to-triggers` uses them): explain output carries no enforcement decision, so a hook registered with either flag silently stops denying anything.

**Sandbox setup for vault writes.** Codex's workspace-write sandbox scopes to the session's git repo root, so a session in your project repo cannot write the vault (a sibling repo) — the write is rejected before any hook fires. Add the vault to your `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
writable_roots = ["/path/to/your/vault"]
```

## Recommended companion

`obsidian-vault` — vault file-format skills (Obsidian Flavored Markdown, Bases, JSON Canvas, Obsidian CLI). The SDD loop writes vault files; `obsidian-vault` handles their format. Enable both in agent-wiki projects.
