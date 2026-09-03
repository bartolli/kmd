# wiki-sdd

Wiki-native spec-driven development loop for the `~/llm-wiki` agent wiki. CoCo (Cortex Code) flavor.

## Skills

| Skill | Role |
|---|---|
| `wiki` | Bootstrap a project into the agent wiki; on-ramp for the constellation. |
| `intent` | Interview intent into `glossary.md` + scaffold scope, or write one idea as an intent. |
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

## Install

One manifest: the repo root's `.cortex-plugin/plugin.json`. It names this flavor's skills by path and carries the hook wiring and MCP registration inline — the sample-manifest shape from the CoCo plugin docs. The repo-root `.claude-plugin/marketplace.json` is a Claude Code surface; CoCo prefers `.cortex-plugin` when both are present.

```bash
cortex plugin install bartolli/kmd     # managed; `cortex plugin update` tracks it
```

For one session without installing, or for local development:

```bash
cortex --plugin-dir /path/to/vault-infra
```

Or symlink the repo into `.cortex/plugins/wiki-sdd` in your project, or list it in the `plugins` array of `~/.snowflake/cortex/settings.json`. `cortex plugin validate /path/to/vault-infra` checks the bundle; `/plugin reload` re-aggregates a change without restarting the session.

This directory is not a standalone plugin — it holds the components the manifest points at: `skills/` and the hook resolver (`hooks/run-kmd-hook.mjs`). `${CORTEX_PLUGIN_ROOT}` in the inline hook commands expands to the installed plugin root, the repo root.

## Prerequisite: a globally installed `kmd`

```bash
npm i -g @bartolli/kmd     # 0.12.0 or newer
```

**This flavor never invokes `npx`.** Both surfaces resolve `kmd` from `PATH` — the MCP server runs the binary directly, and this bundle carries its own hook resolver (`hooks/run-kmd-hook.mjs`) with no `npx` fallback, unlike the Claude and Codex adapters. Managed CoCo environments are the ones most likely to block `npx` or run offline, where a fallback that cannot execute turns a missing prerequisite into a silent no-op. Instead, a missing or pre-0.12.0 `kmd` prints one stderr line naming the fix and exits 0 — the gates stay off, loudly, and never block a prompt.

`PATH` is one of the six variables CoCo passes to a plugin MCP server, which is why a global install is the whole prerequisite.

## Vault path

Neither surface passes a vault root, so `kmd`'s resolution chain runs in full — highest tier first:

1. **Project vault** — a repo carrying its own vault (co-located `vault/vault.yaml`, a `.kmd`-marked root vault, or a committed `.kmd/config.yaml`; `kmd init --local` scaffolds the shape). Resolved from the session's working directory.
2. **`$WIKI_VAULT`** — exported in the shell that launches CoCo. The bundled registration (inline in the root manifest) forwards it (and `KMD_PROJECT_DIR`) explicitly, since the plugin server's environment is otherwise scrubbed.
3. **Machine default** — `kmd config set default_vault /path/to/vault`. The recommended setup: one command, no environment plumbing, survives a GUI-launched session.

Configure at least one. With none of them resolvable, the server exits at bind time naming every route it tried, and the gate hooks degrade to no-ops with one stderr line.

`prime` and `search` arrive namespaced by plugin: **`mcp__wiki-sdd-wiki__prime`** and `mcp__wiki-sdd-wiki__search`. Set `WIKI_MCP_LOG_LEVEL` to override the server's default `info`.

**Per-project vaults.** Gate hooks are project-aware on their own — every event carries the session working directory. The MCP server binds once, from the directory CoCo was launched in, so a project vault resolves without extra setup as long as the session started at the project root. `-w`/`--workdir` does not move the server's directory; in that case `export KMD_PROJECT_DIR="$PWD"` before launching.

## Gate hooks

Registers the `kmd hook` gate engine on five events — no manual wiring:

- **SessionStart** — wiki orientation for the bound scope.
- **UserPromptSubmit** — prompt-time reminders from your vault's `triggers_extra` (`vault.yaml`), injected once per session per trigger.
- **PreToolUse** — vault-declared gates on tool calls: deny with a reason, warn, or inject context, including state-aware preconditions (`when: newer-than`).
- **PostToolUse** — auto validate + sync: after a mutation inside the vault — an `edit`/`write`/`apply_patch`, or a `bash` command whose string names a vault path, including `rm`, `mv`, redirections, and glob deletions — `kmd validate` runs; findings return into the session for the agent to fix and the index holds until they are; a clean write syncs silently. Tool calls outside the vault cost nothing.
- **Stop** — handoff gate before the session closes.

The `PostToolUse` matcher is `edit|write|apply_patch|bash`. CoCo matches it against the **runtime tool id**, which is lowercase — a capitalized matcher silently matches nothing, and vault writes would then never validate or sync.

Scope resolves from the session's working directory when your `vault.yaml` scopes declare `repo:`; `WIKI_SCOPE` in the environment overrides it.

**Never wire `--explain` or `--dry-run` into hook registrations.** They are probe flags for testing triggers by hand (`$to-triggers` uses them): explain output carries no enforcement decision, so a hook registered with either flag silently stops denying anything.

## Sandbox and administrator controls

The plugin does not set `requiresSandbox`, so it never asks CoCo to start the sandbox runtime. If you enable the sandbox yourself, a vault living outside the session's repo needs to be mounted or writes fail before any hook runs: `cortex --mount hostPath=/path/to/vault,mountPath=/path/to/vault`.

If `prime` and `search` are missing while the gate hooks still fire, check whether your administrator set `areUserMcpServersAllowed: false` in managed settings — plugin MCP servers are skipped along with user ones in that mode, and hooks are unaffected because they are not MCP. `/mcp` shows whether the server is known to the session.

## Recommended companion

`obsidian-vault` — vault file-format skills (Obsidian Flavored Markdown, Bases, JSON Canvas, Obsidian CLI). The SDD loop writes vault files; `obsidian-vault` handles their format. Enable both in agent-wiki projects.
