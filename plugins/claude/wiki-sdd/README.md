# wiki-sdd

Wiki-native spec-driven development loop for the `~/llm-wiki` agent wiki.

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
| `signal-dense` | Canonical-vocabulary response register for long agentic threads. |

Arc: `/grill-with-docs` → `/to-prd` → `/triage` → `/to-issues` → `/tdd` → `/retro`.

`signal-dense` sits outside the arc: invoke it before authoring specs, ADRs, and blueprints so wiki artifacts are written in canonical vocabulary rather than drafted loose from memory.

## MCP server

Ships `.mcp.json` registering the `wiki` stdio server (`prime`, `search` tools) via `npx @bartolli/kmd`; on install the plugin asks for your vault path (`vault_path` user config). If the `wiki` server is also registered globally in `~/.mcp.json`, remove the global entry when enabling this plugin to avoid double registration.

## Gate hooks

Registers the `kmd hook` gate engine on three events — no manual wiring:

- **UserPromptSubmit** — prompt-time reminders from your vault's `triggers_extra` (`vault.yaml`), injected once per session per trigger.
- **PreToolUse** — vault-declared gates on tool calls: deny with a reason, warn, or inject context, including state-aware preconditions (`when: newer-than`).
- **PostToolUse** — auto validate + sync: after a write inside the vault, `kmd validate` runs; findings return into the session for the agent to fix and the index holds until they are; a clean write syncs silently. Writes outside the vault cost nothing.

Scope resolves from the session's working directory when your `vault.yaml` scopes declare `repo:`; a project can override with `WIKI_SCOPE` in its settings `env`. The hooks run through a resolver wrapper: a globally installed `kmd` at `0.7.0`+ runs in-process (fast path — `npm i -g @bartolli/kmd` recommended), else `npx @bartolli/kmd@latest`. A missing or invalid trigger config degrades to a no-op with one stderr diagnostic — gates never block unrelated work.

## Recommended companion

`obsidian-vault` — vault file-format skills (Obsidian Flavored Markdown, Bases, JSON Canvas, Obsidian CLI). The SDD loop writes vault files; `obsidian-vault` handles their format. Enable both in agent-wiki projects.
