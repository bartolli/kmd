# wiki-sdd

Wiki-native spec-driven development loop for the `~/llm-wiki` agent wiki, packaged
as an [Agent Plugins](https://agent-plugins.org) 1.0.0 plugin: `plugin.json`, the
skills under `skills/`, the `wiki` MCP server in `mcp.json`, and the launcher it
runs. A conformant client — Kiro today — installs this folder as is. Claude Code,
Codex, and Cortex Code take rendered adapters of the same source (`plugins/claude`,
`plugins/codex`, and the repo-root Cortex manifest).

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

Arc: `/intent` → `/to-stories` → `/triage` → `/to-issues` → `/tdd` → `/retro` whenever drift is suspected → `/handoff` to close.

`signal-dense` and `/to-triggers` sit outside the arc: invoke `signal-dense` before
authoring specs, ADRs, and blueprints so wiki artifacts are written in canonical
vocabulary rather than drafted loose from memory; invoke `/to-triggers` whenever a
rule should become a gate — it interviews intent, authors the matching, and writes
`vault.yaml` only after a dry-run proves fire and near-miss behavior.

## Install on Kiro

The package is a power. Kiro's GitHub import takes a repository root, and this
package sits at `plugins/src/wiki-sdd`, so clone and import the folder:

```bash
git clone --depth 1 https://github.com/bartolli/kmd /tmp/kmd
```

Then **Powers** panel → **Add Custom Power** → **Import power from a folder** →
`/tmp/kmd/plugins/src/wiki-sdd`. Kiro loads the power's skills and its MCP server
when a prompt matches one of the manifest's keywords (`wiki`, `sdd`, `kmd`, …);
the skills invoke as `/wiki`, `/intent`, and so on. An update is a re-import after
a release; each `SKILL.md` carries its package version in `metadata.version`.

Node 22 or newer is required (`node:sqlite`). A global engine keeps the server's
start fast:

```bash
npm i -g @bartolli/kmd
```

## The `wiki` server

`mcp.json` runs `node ${PLUGIN_ROOT}/scripts/run-kmd.mjs mcp`. The launcher runs a
global `kmd` at or above 0.16.0 in-process, falls back to `npx -y @bartolli/kmd@latest`
where `npx` exists, and otherwise prints one line on stderr. The server exposes two
tools, `prime` and `search`.

The registration carries no vault root. The server resolves its vault through the
engine's chain, which ends at the machine default:

```bash
kmd config set default_vault /absolute/path/to/vault
```

A project vault — one the repo carries — needs a workspace-level registration that
names it, since the packaged server has no project signal on Kiro: `.kiro/settings/mcp.json`
from `skills/wiki/templates/mcp-entry-kiro.json.template`. Workspace and user
registrations merge; the workspace wins.

Kiro's agent cannot read MCP resources, so the `wiki://` authoring guide and
template resources are out of reach from this seat. The same templates live on the
vault filesystem (scaffolded by `kmd init`); skill bodies name that route alongside
the resource route.

## Hooks

Hooks are not an Agent Plugins component. The gates — prompt-time reminders, tool
denies, validate + sync after vault writes, the stop-time handoff gate — reach Kiro
through a hook file under `~/.kiro/hooks/` that the `/wiki` onboarding writes; this
package does not carry that step yet. Until it does, close the loop by hand after
editing vault pages:

```bash
kmd validate /path/to/vault && kmd sync
```
