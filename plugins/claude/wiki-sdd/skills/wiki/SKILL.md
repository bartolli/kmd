---
name: wiki
description: Bootstrap an existing project (not yet on the wiki) to use the `~/llm-wiki` Obsidian-based agent wiki. Scaffolds a new vault when none exists (vault.yaml, served templates, domain dirs). Writes three sections to the project instructions from a bundled template — `## First read`, `## Wiki integration` (declaring `WIKI_SCOPE`, `WIKI_ISSUE_TRACKER`, `WIKI_TRIAGE_LABELS`), and `## Sub-agent spawning` — and guides harness-aware MCP registration and file placement (Claude Code, Kiro IDE/CLI) when not already available. Also serves as the central mental-model hub for the wiki-aware skill constellation (`/grill-with-docs`, `/to-prd`, `/triage`, `/to-issues`, `/tdd`, `/retro`) and lists companion skills (`obsidian-markdown`, `obsidian-bases`, `obsidian-cli`, `json-canvas`). Use when the user says "set up wiki", "wire this project to the wiki", "connect this project to my wiki", "/wiki", "bootstrap a new vault", "this project isn't on the wiki yet", or when other wiki-aware skills report `WIKI_SCOPE` is missing.
metadata:
  version: "0.14.0"
---

# Wiki — Project Bootstrap

Wire the current project into the `~/llm-wiki` agent wiki so wiki-aware skills can find context, scope, and the issue tracker convention. The wiki is the canonical surface for cross-session orientation; this skill is the on-ramp from a consumer project.

This is a **prompt-driven bootstrap**, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## What this skill produces

In the consumer project:

1. **Project instructions** (`CLAUDE.md`, `AGENTS.md`, or equivalent) populated from `templates/project-agents.md.template` with three sections: `## First read`, `## Wiki integration` (carrying `WIKI_SCOPE`, `WIKI_ISSUE_TRACKER`, `WIKI_TRIAGE_LABELS`), and `## Sub-agent spawning`.
2. **MCP registration guidance** — only when the `wiki` MCP server is not already available (plugin-bundled or user-registered). Shows the canonical `npx @bartolli/kmd mcp <vault-path>` JSON and lets the user place it.

Both are idempotent — if a section/entry already exists, update in place rather than duplicate.

In the vault, only when no vault exists yet (new-vault bootstrap):

3. **Barebone vault structure** the MCP server requires — scaffolded by `kmd init <vault-dir>` (starter `vault.yaml` with empty `scopes`, the 11 served templates, and the `projects/`, `research/`, `notes/` domain dirs), the user's first scope then added to `vault.yaml` per `references/vault-yaml.md` § Minimal starter.

## Mental model

### The wiki itself

- Three domains (`projects/`, `research/`, `notes/`) under `~/llm-wiki/vault/`
- A controlled vocabulary of project scopes defined in `~/llm-wiki/vault/vault.yaml` under `scopes:` — adding a new scope requires explicit user approval per the vault blueprint
- Two MCP tools: `prime(scope, task?)` for orientation, `search(query, scope?, kind?, limit?)` for retrieval
- Templates exposed as MCP resources at `wiki://template/{domain}/{kind}` (11 templates: project-{index, primer, spec, adr, plan, ops, story}, research-{index, article, src}, note) — served from `templates/` at the vault root, re-read on every call; a missing file errors at resource-read time

A consumer project becomes wiki-aware by declaring `WIKI_SCOPE: <scope>` in its project instructions (`CLAUDE.md`, `AGENTS.md`, or equivalent). The agent reads this at session start and calls `prime(scope)` automatically.

### Wiki-aware skill constellation

`/wiki` is the on-ramp. The other wiki-aware skills form a workflow loop, each consuming what the previous produced:

| Skill | Reads | Writes |
|---|---|---|
| `/grill-with-docs` | wiki state via `prime(scope)`; codebase (brownfield) | `index.md`, `primer.md`, `spec-context.md`, lazy `adr-{topic}.md` |
| `/to-prd` | conversation; `spec-context.md`; existing ADRs | thin `plan-{name}.md` + per-story `plan/{name}/story-N-{slug}.md` |
| `/triage` | story files | mutates `triage_state` / `category` in story frontmatter; `adr-no-{slug}.md` on wontfix |
| `/to-issues` | story files; codebase | refined `## Slices` in story body; remote issues in GH/GitLab mode |
| `/tdd` | story scenarios as test spec; referenced specs | code + tests; ticks slice checkbox |
| `/retro` | the session's own claims, gates, and open work | story scope extensions, dated plan retro notes, needs-triage stories, primer Open Questions — runs BEFORE primer resync |
| `/to-triggers` | a stated rule, or a protocol rule that just failed to fire | tested trigger entries under `vault.yaml` `triggers_extra` — on demand, outside the loop |

Typical session arc for new work: `/grill-with-docs` → `/to-prd` → `/triage` → `/to-issues` → `/tdd` (per slice) → repeat triage when stories complete or new ones surface → `/retro` before the closing primer resync. `/to-triggers` joins whenever a rule proves it needs to become a gate.

### Companion skills (vault file editing)

When Claude edits files in the vault, four global skills cover Obsidian-flavored markdown and adjacent file types. They are NOT wiki-aware (no `WIKI_SCOPE` knowledge), but they handle the *file format* that the wiki uses:

| Skill | When to use |
|---|---|
| `obsidian-markdown` | Authoring `.md` files in the vault — wikilinks, callouts, embeds, frontmatter, tags. Triggers on most edits inside `~/llm-wiki/vault/`. |
| `obsidian-bases` | Editing `.base` files in `vault/views/`. Bases are human-navigation surfaces (table/card views over the vault); agents rarely author them but should use this skill when asked. |
| `obsidian-cli` | Only when a live Obsidian instance is genuinely needed — plugin/theme dev, screenshots, Dataview re-render. **Not** the canonical search/read surface — use the wiki MCP `search` tool and filesystem `Read` instead. |
| `json-canvas` | Editing `.canvas` files (mind maps, flowcharts). Not in the standard wiki authoring loop. |

These compose with the wiki-aware skills: `/to-prd` writes story files (using `wiki://template/project/story` for structure and frontmatter), and `obsidian-markdown` handles the Obsidian-flavored body content (wikilinks, callouts) inside that file.

### Harness placement

This skill runs anywhere SKILL.md skills are supported — same slash-invocation dialect — but where files land differs per harness:

| | Claude Code | Kiro (IDE and CLI) |
|---|---|---|
| Skill files | `wiki-sdd` plugin, or `~/.claude/skills/wiki/` | `.kiro/skills/wiki/` (workspace) or `~/.kiro/skills/wiki/` (global) — one directory per skill, `SKILL.md` inside |
| MCP registration | `.mcp.json` at the project root, or user-level settings | `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (user) — both merge, workspace wins |
| Project instructions | `CLAUDE.md` or `AGENTS.md` (step 6) | `AGENTS.md`, read automatically; `.kiro/steering/*.md` when inclusion modes are wanted |

### Gate hooks

The plugin registers `kmd hook` on the harness's events — this bootstrap adds no wiring step. Three behaviors ride along: prompt-time reminders, tool gates, and auto validate + sync after every vault write (the resync protocol runs as an event; validation findings return as hook feedback and hold the sync until fixed). The bootstrap's only responsibilities toward them: declare `repo:` on each scope in vault.yaml so the engine resolves the active scope from the session's working directory, and leave the trigger sections empty — vault-owned triggers grow from observed failures (`references/vault-yaml.md` § Harness gate triggers), never from upfront speculation. When that moment arrives — the user says "add a rule/hook/trigger for…", or a prose rule just failed to fire — route to `/to-triggers`: it interviews the intent, authors the matching mechanics, dry-runs fire and near-miss cases, and writes `vault.yaml` only on approval.

## Process

### 1. Explore

Read the current state. Don't assume.

- `git remote -v` — does this repo have a remote? GitHub? GitLab? Or no remote?
- Read `CLAUDE.md` or `AGENTS.md` at the project root (whichever exists). Is there already a `## Wiki` block?
- Read `.mcp.json` at the project root if it exists. Is the `wiki` server already registered?
- Read `vault.yaml` in the vault root — the `scopes:` field is the authoritative scope vocabulary.
- Check whether `prime` and `search` tools from a wiki MCP server are already available in the session.

### 2. Determine scope

**If `vault.yaml` does not exist (new vault):** this is vault bootstrap, not just project bootstrap. Run `kmd init <vault-dir>` — the engine scaffolds the starter `vault.yaml` (empty `scopes`), the 11 served templates, and the `projects/`, `research/`, `notes/` domain dirs, refusing a non-empty target. Then add the user's first scope to the generated `vault.yaml` per `references/vault-yaml.md` § Minimal starter. The file is fail-loud — the MCP server and `kmd` tooling refuse to run on an invalid one — so validate (`kmd validate`) before continuing. Trigger sections start empty and stay empty at bootstrap; when the first rule earns a gate, `/to-triggers` authors it.

**If the user declares a custom kind** (an object-form `kinds` entry, now or later): offer to co-author its template at `templates/{name}.md` right away — protocol in `references/vault-yaml.md` § Custom kinds. A declared kind without its template draws a `kmd validate` warning until the file exists.

Ask the user which wiki scope this project belongs to. Show the scopes from `vault.yaml` as options.

**If the user names a scope already in `vault.yaml`:** proceed.

**If the user names a scope NOT in `vault.yaml`:** STOP. Per the vault blueprint, new scopes require explicit user approval. Surface this clearly — list the current scopes from `vault.yaml` and explain:

> "`<requested-scope>` is not in the wiki's scope vocabulary (currently: `<comma-separated scopes from vault.yaml>`). Adding a new scope requires updating `~/llm-wiki/vault/vault.yaml` and is a deliberate vocabulary extension. Do you want to (a) approve adding `<scope>` to the vocabulary, (b) pick an existing scope, or (c) abort?"

If (a): add the new scope entry to `vault.yaml`'s `scopes:` field (with `status: active`), AND offer to run `/grill-with-docs` next to scaffold `projects/{scope}/`.

### 3. Determine issue tracker

Detect:

- `git remote -v` shows a `github.com` host → recommend `WIKI_ISSUE_TRACKER: github`
- `git remote -v` shows a `gitlab.com` (or self-hosted GitLab) host → recommend `WIKI_ISSUE_TRACKER: gitlab`
- No remote, or user prefers offline-first → recommend `WIKI_ISSUE_TRACKER: local`

State your recommendation with reasoning. Let the user override.

**Behavior implications** (mention briefly):

- `github` / `gitlab`: `/to-issues` mirrors `ready-for-agent` slices to the remote tracker; story files in the wiki remain canonical.
- `local`: slices and triage state live entirely in story files under `plan/{plan-name}/story-N-{slug}.md`; no remote calls.

### 4. Triage label vocabulary

Default to Matt Pocock's canonical roles:

- `needs-triage` — story needs evaluation
- `needs-info` — agent waits on user clarification (in solo+Claude context, this means *Claude needs a decision from the user*)
- `ready-for-agent` — fully specified, AFK-ready
- `ready-for-human` — needs human implementation (judgment, external access, hardware)
- `wontfix` — will not be actioned

In a solo+Claude context, `needs-info` semantically reads as "Claude is blocked on a user decision." This is the intended interpretation — flag it once during setup so the user understands the role mapping.

If the user wants to override any label string (because their issue tracker uses different conventions), capture the mapping in `WIKI_TRIAGE_LABELS:` as a JSON object.

Default: `WIKI_TRIAGE_LABELS: {"needs-triage":"needs-triage","needs-info":"needs-info","ready-for-agent":"ready-for-agent","ready-for-human":"ready-for-human","wontfix":"wontfix","bug":"bug","enhancement":"enhancement"}`

### 5. Detect MCP registration state

Check whether the `wiki` MCP server is already available to this session — look for it in the available tools list (a `prime` and `search` tool from a wiki-named server).

**If a `wiki-sdd` plugin is installed:** the plugin bundles its own `.mcp.json` with the server registration. Nothing to do — skip to step 6.

**If the skill is standalone (no plugin) and no wiki MCP server is available:** the user needs to register it. Show the canonical registration JSON from `templates/mcp-entry.json.template` with the vault path filled in:

```json
{
  "mcpServers": {
    "wiki": {
      "command": "npx",
      "args": ["-y", "@bartolli/kmd", "mcp", "/absolute/path/to/vault"]
    }
  }
}
```

**Placement is harness-specific** (§ Harness placement):

- **Claude Code:** project-local `.mcp.json`, or user-level settings — let the user choose the scope.
- **Kiro (IDE and CLI):** `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (user), from `templates/mcp-entry-kiro.json.template` — Kiro wraps the same entry in `mcpServers` and adds `disabled` and `autoApprove`; pre-approving `prime` and `search` keeps orientation friction-free, and `env` values support `${VARIABLE}` expansion. The Kiro CLI can register the same server via `kiro-cli mcp add` (defer to its `--help` for current flags rather than guessing them).
- **Other harnesses:** show the generic JSON and let the user place it per their harness's MCP docs. Don't prescribe OS-specific paths.

### 6. Confirm and write the project CLAUDE.md / AGENTS.md

**Pick the file to edit:**

- If `CLAUDE.md` exists at the project root, edit it.
- Else if `AGENTS.md` exists, edit it (same template applies).
- If neither exists, ask which one to create — don't pick for the user.

**Kiro:** picks up `AGENTS.md` automatically (always included, no inclusion modes) — target it with the same template. A `.kiro/steering/` file is the native alternative when the user wants conditional inclusion; the same three sections apply.

**Use the bundled template** at `templates/project-agents.md.template`. Fill these placeholders:

| Placeholder | Source |
|---|---|
| `{{scope}}` | The validated scope from step 2 |
| `{{issue_tracker}}` | `github` / `gitlab` / `local` from step 3 |
| `{{triage_labels}}` | The JSON map from step 4 |

**If a `## First read`, `## Wiki integration`, or `## Sub-agent spawning` section already exists in the target file, update those sections in place** rather than appending duplicates. Don't overwrite user edits to surrounding sections.

**Per-scope adaptations to the template:**

- The Sub-agent spawning section references `projects/{{scope}}/ops/ops-slicing-protocol`. If that file doesn't exist in the vault, change "if it exists" to "if/when it exists" — keep the pointer so future readers know where to look.
- The template adds two lines (`WIKI_ISSUE_TRACKER`, `WIKI_TRIAGE_LABELS`) that aren't in the original minimal shape. They're inert if unused; `/to-issues` reads `WIKI_ISSUE_TRACKER`, `/triage` reads `WIKI_TRIAGE_LABELS`.

**Show the rendered template to the user before writing.** Let them edit. Then write.

### 7. Done

Tell the user setup is complete and which wiki-aware skills will now read from these files. Mention they can edit the file directly later if `WIKI_SCOPE` or `WIKI_ISSUE_TRACKER` changes.

Suggest the next step:

- If `projects/<scope>/index.md` already exists in the vault → "You're set up. Try `/grill-with-docs` to refine intent or kick off a new workstream."
- If it doesn't exist → "The vault doesn't have a scope folder for `<scope>` yet. Run `/grill-with-docs` to scaffold it."

## Rules

- **Never silently add a new scope** to `vault.yaml`. Always confirm with the user.
- **Never overwrite a non-empty `CLAUDE.md` or `AGENTS.md`** without showing the diff first.
- **Check for an existing wiki MCP server** (plugin-bundled or user-registered) before offering to register one. If the `wiki-sdd` plugin is installed, its `.mcp.json` already handles registration.
- **Use `npx @bartolli/kmd mcp <vault-path>`** for standalone registration — don't construct `pnpm`/`tsx` dev paths. Let the user choose where to place the `.mcp.json`.
- **Always check for existing `## First read`, `## Wiki integration`, `## Sub-agent spawning` sections** before writing — update in place if found.
- **Use the bundled `templates/project-agents.md.template`** rather than emitting the structure inline. Edits to the template propagate to all future bootstraps.
- **Scaffold new vaults with `kmd init <vault-dir>`** — the engine embeds the template set; filenames are the server's URI→file contract and the content is served to future agents as-is; never author templates inline, rename files, or assemble the structure by hand.
- **Don't run `/grill-with-docs` automatically** — suggest it as the next step, but let the user invoke it.
