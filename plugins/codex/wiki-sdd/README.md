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

Arc: `$grill-with-docs` → `$to-prd` → `$triage` → `$to-issues` → `$tdd` → `$retro`.

`signal-dense` sits outside the arc: invoke it before authoring specs, ADRs, and blueprints so wiki artifacts are written in canonical vocabulary rather than drafted loose from memory.

## MCP server

Ships `.mcp.json` registering the `wiki` stdio server (`prime`, `search` tools) via `npx @bartolli/kmd`. The launcher reads `WIKI_VAULT` and falls back to `~/llm-wiki/vault`; set `WIKI_MCP_LOG_LEVEL` to override the default `info` log level. If the `wiki` server is also registered globally, remove the global entry when enabling this plugin to avoid double registration.

## Gate hooks

Registers the `kmd hook` gate engine — no manual wiring:

- **UserPromptSubmit** — prompt-time reminders from your vault's `triggers_extra` (`vault.yaml`), injected once per session per trigger.
- **PostToolUse** — auto validate + sync: after a write inside the vault (`Edit`, `Write`, or `apply_patch`), `kmd validate` runs; findings return into the session for the agent to fix and the index holds until they are; a clean write syncs silently. Writes outside the vault cost nothing.

The hooks run through a resolver wrapper: a globally installed `kmd` at `0.6.0`+ runs in-process (fast path — `npm i -g @bartolli/kmd` recommended), else `npx @bartolli/kmd@latest`. A missing or invalid trigger config degrades to a no-op with one stderr diagnostic — gates never block unrelated work.

## Frontmatter hook

Ships a `PreToolUse` hook that validates YAML frontmatter for Markdown edits under the vault's `projects/`, `research/`, and `notes/` directories. Review and trust the hooks with `/hooks` after installing the plugin.

## Recommended companion

`obsidian-vault` — vault file-format skills (Obsidian Flavored Markdown, Bases, JSON Canvas, Obsidian CLI). The SDD loop writes vault files; `obsidian-vault` handles their format. Enable both in agent-wiki projects.
