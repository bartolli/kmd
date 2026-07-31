# wiki-sdd

Wiki-native spec-driven development loop for the `~/llm-wiki` agent wiki, delivered
as [Agent Skills](https://agentskills.io) for Kiro — IDE and CLI read the same skill
folders, invoked as `/` slash commands or activated on description match.

## Skills

| Skill | Role |
|---|---|
| `wiki` | Bootstrap a project into the agent wiki; on-ramp for the constellation. |
| `grill-with-docs` | Interview intent into `spec-context.md` + scaffold scope. |
| `to-prd` | Synthesize conversation into a plan + per-story files. |
| `triage` | Move stories through the triage state machine. |
| `to-issues` | Slice stories into tracker issues. |
| `tdd` | Implement a ready-for-agent slice via red-green-refactor. |
| `retro` | Two-question retrospective gate before primer resync; answers become wiki artifacts. |
| `to-triggers` | Author vault gate triggers from stated intent; dry-run tested, approval-gated. |
| `signal-dense` | Canonical-vocabulary response register for long agentic threads. |

Arc: `/grill-with-docs` → `/to-prd` → `/triage` → `/to-issues` → `/tdd` → `/retro`.

`signal-dense` and `/to-triggers` sit outside the arc: invoke `signal-dense` before
authoring specs, ADRs, and blueprints so wiki artifacts are written in canonical
vocabulary rather than drafted loose from memory; invoke `/to-triggers` whenever a
rule should become a gate — it interviews intent, authors the matching, and writes
`vault.yaml` only after a dry-run proves fire and near-miss behavior.

## Install

Nine skills ship as sibling folders under `skills/`. Clone and copy them in one
step; per-folder GitHub import works but takes nine round-trips.

```bash
git clone --depth 1 https://github.com/bartolli/kmd /tmp/kmd
cp -R /tmp/kmd/plugins/kiro/wiki-sdd/skills/* ~/.kiro/skills/       # global: all workspaces
# or into .kiro/skills/ at a project root for workspace scope
```

Both seats read both locations; on a name conflict the workspace copy wins. The IDE
alternative: **Agent Steering & Skills** panel → **+** → **Import a skill** → paste
the GitHub URL of one skill folder (the folder, not the repo root), once per skill.

Installed skills are copies — nothing tracks the repo. An update is delivered per
seat by re-copying (or re-importing) after a release; each rendered SKILL.md carries
its plugin version in `metadata.version`.

The CLI's default agent loads skills from both locations automatically. Custom
agents don't; add to the agent's `resources`:

```json
"resources": [
  "skill://.kiro/skills/*/SKILL.md",
  "skill://~/.kiro/skills/*/SKILL.md"
]
```

## MCP server

Register the `wiki` server (`prime`, `search` tools) in `.kiro/settings/mcp.json`
(workspace) or `~/.kiro/settings/mcp.json` (user). The bundled template is
`skills/wiki/templates/mcp-entry-kiro.json.template`:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "npx",
      "args": ["-y", "@bartolli/kmd", "mcp", "/absolute/path/to/vault"],
      "env": {},
      "disabled": false,
      "autoApprove": ["prime", "search"]
    }
  }
}
```

Replace the vault path — the positional root is authoritative (it beats a
`WIKI_VAULT` env var). Node 22+ required (`node:sqlite`).

Kiro's agent cannot read MCP resources, so the `wiki://` authoring guide and
template resources are out of reach from this seat. The same templates live on the
vault filesystem (scaffolded by `kmd init`); skill bodies name that route alongside
the resource route.

## Hooks — one wirable today

The claude and codex adapters register the full `kmd hook` gate engine: prompt-time
reminders, tool gates, auto validate + sync after vault writes, and a stop-time
handoff gate. On kiro, most of that surface cannot yet carry the engine's
contract — the CLI cannot deliver a pretool deny or posttool feedback inside the
gates-fail-open rule, and the IDE has no equivalent mechanical channel.

The exception is the **handoff gate**: kiro CLI's `stop` hook blocks via exit 0 +
stdout JSON, exactly the engine's contract. If the vault has outstanding
`kmd validate` errors when the agent finishes responding, the gate sends it back
once with the fix list. Wire it in an agent configuration (`.kiro/agents/` or
`~/.kiro/agents/`):

```json
"hooks": {
  "stop": [
    { "command": "npx -y @bartolli/kmd hook stop /absolute/path/to/vault" }
  ]
}
```

A globally installed `kmd` (`npm i -g @bartolli/kmd`) can replace the `npx` form
with `kmd hook stop /absolute/path/to/vault`. Everything else stays manual for
now — close the loop after editing vault pages:

```bash
kmd validate /path/to/vault && kmd sync
```
