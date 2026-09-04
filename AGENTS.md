# AGENTS.md — vault-infra

Tooling monorepo for the llm-wiki: the single `@bartolli/kmd` binary (vault → SQLite FTS5 sync, `wiki-mcp` stdio server, `kmd hook` harness gates) plus the per-harness wiki-sdd plugin adapters. The vault is a sibling repo at `../vault/`; the system blueprint is `../README.md`.

## First read

Wiki primer at `projects/llm-wiki/primer.md`, loaded via the wiki MCP server's `prime(scope="llm-wiki")` tool. The tool prefix varies by harness and server registration name — discover it from the available tools list at session start. Without MCP tools, `kmd prime llm-wiki` returns the same briefing.

## Wiki integration

- `WIKI_SCOPE: llm-wiki`
- `WIKI_ISSUE_TRACKER: none` — slices live inline in story files; nothing mirrors to GitHub issues.
- `WIKI_TRIAGE_LABELS: {"needs-triage":"needs-triage","needs-info":"needs-info","ready-for-agent":"ready-for-agent","ready-for-human":"ready-for-human","wontfix":"wontfix","bug":"bug","enhancement":"enhancement"}`

`prime(scope=llm-wiki)` carries orientation, active ADRs, plan state, and read order. Design rationale lives in wiki ADRs, not this file.

Authoring rules and resync protocol: `wiki://authoring` (MCP resource) or `kmd resource wiki://authoring` (CLI, same content).

Wiki-aware skills: `/intent`, `/to-stories`, `/triage`, `/to-issues`, `/tdd`, `/retro`, `/handoff`. Run `/intent` to scaffold a new scope or refine intent on an existing one. `/wiki` is the central hub — invoke it for the full constellation map. `/retro` grooms the session whenever drift is suspected; `/handoff` closes it, gated on a retro newer than the primer.

Companion skills for vault file editing: `obsidian-markdown` (wikilinks/callouts/frontmatter in `.md` files), `obsidian-bases` (`.base` views), `obsidian-cli` (live-Obsidian-only operations), `json-canvas` (`.canvas` files).

## Layout

`packages/{db,cli,mcp}` compose into `packages/kmd` — the esbuild-bundled npm package, the only published artifact. `plugins/src/wiki-sdd` is the shared plugin source, laid out as an Agent Plugins 1.0.0 package that Kiro installs as is; `plugins/{claude,codex,coco}/wiki-sdd` are rendered adapter copies plus per-harness chrome, all authored here ([[adr-plugin-authoring-surface]], [[adr-agent-plugins-package-source]]). TypeScript strict, pnpm workspace, Biome, Vitest, `node:sqlite`.

## Invariants

Each entry states what holds and what breaks when it doesn't. Reason from the mechanism for cases this list doesn't name.

- **The MCP server's stdout is the JSON-RPC channel.** One stray `console.log` corrupts a protocol frame mid-session. Diagnostics go to stderr and `~/.local/state/wiki-mcp/server.log` (pino multistream).
- **Tool handlers never throw** — errors return structured `{isError: true, content: [{code, message}]}`. A thrown error takes down the stdio server for the whole session over one bad call. Startup is the opposite: invalid `WIKI_VAULT` or `vault.yaml` crashes loud before serving.
- **Two MCP tools — `prime`, `search` — frozen by blueprint §10.** Templates are resources (`wiki://template/…`), hooks are CLI surface. A third tool is a blueprint amendment, not a feature.
- **`search` returns ranked candidates, never page bodies.** The agent opens files itself; bodies through the tool re-spend the context the index exists to save.
- **No write tools.** The git-tracked vault is canonical; agents write markdown and the posttool hook validates + syncs. A write tool would put the disposable index in the write path.
- **The index is disposable and per-vault** (`~/.kmd/db/{vault-key}/index.db`). Nothing may treat it as a source of truth — `kmd db reset` deletes it at will. Hook state predicates read the vault filesystem for the same reason.
- **`vault.yaml` is the vocabulary source of truth and loads fail loud.** Sync aborts on missing/invalid config or an unlisted scope before the first index write; a lenient load would let drift into the index silently.
- **Path is authoritative for `scope`/`topic`** (`projects/{scope}/…`); frontmatter is descriptive. Deriving from frontmatter would let a moved file silently fork the taxonomy.
- **Everything under `kmd hook` exits 0**, one stderr diagnostic on degraded paths. Exit 2 on UserPromptSubmit blocks the user's prompt — gates fail open, loudly. The operator surface (`sync`, `validate`) keeps real exit codes.
- **`scopes.*.repo` in `vault.yaml` is load-bearing** — `kmd hook` resolves the active scope from the event cwd against it. Precedence: `--scope` > `$WIKI_SCOPE` > repo match.
- **Domain logic runs without a transport.** `bin/stdio.ts` wires the server; handlers validate input (one Zod schema per tool: registration, runtime validation, `z.infer`), call domain functions, serialize. SQL lives in the domain layer, never in handlers.
- **Adapter copies are build output of `@llm-wiki/render`.** Shared edits go in `plugins/src/wiki-sdd/` (`plugins/render-manifest.yaml` carries the classification and dialects); a hand-edited rendered file diverges silently until the next render overwrites it. `pnpm --filter @llm-wiki/render check` asserts every copy matches the rendered output — the release chain's step 4 ([[ops-publish-kmd]]).

## Gotchas

- Hook wiring is not picked up from staged files: claude re-registers in-session via `/reload-plugins` (witnessed at 0.15.0), codex only from the materialized plugin cache (`codex plugin add`) — without one of those, a hook change is silently unwired until the next session start.
- Fast-fail server crashes don't reach Claude Code's `mcp-logs-*` capture; `tail -f ~/.local/state/wiki-mcp/server.log` (`src/lib/diag.ts` writes pre-pino checkpoints synchronously).
- `node:sqlite` prints ExperimentalWarning on older Node 22.x; the kmd entry filters exactly that warning and passes the rest — stderr is the hook diagnostics channel.
- `kmd mcp <vault-root>`: the positional root beats `$WIKI_VAULT`.
- Never hand-edit version pins — `pnpm add [-D] [--filter <pkg>]`; the lockfile is the source of truth.

## Working

```bash
pnpm -r run typecheck && pnpm -r run test && pnpm lint   # green before any commit
WIKI_VAULT=../vault pnpm --filter @bartolli/kmd exec tsx bin/kmd.ts <validate|sync|config|hook …>
```

Commit prefix `{type}({area})` — areas as practiced: `cli`, `mcp`, `db`, `kmd`, `plugins`, `release`. Prefer a new commit over `--amend`; never `--no-verify`. Release chain: [[ops-publish-kmd]]; version/tag rules: `.claude/rules/commit-tag.md`.

## Sub-agent spawning

When spawning a sub-agent for llm-wiki work, the prompt must include:

- the WIKI_SCOPE (so it can prime),
- the specific spec / ADR section relevant to the task,
- the slicing methodology pointer (`projects/llm-wiki/ops/ops-slicing-protocol`) if it exists.

Don't assume the sub-agent will discover these via search.

Before briefing work that builds on an external surface (protocol
spec, SDK, harness plugin API), verify that surface's current state —
revision, deprecation status — by checking its published docs, never
from model memory; state the checked result in the brief. A stale
surface routes to the story's Decisions before any implementation
(witnessed: MCP Roots adopted in-tree the week revision 2026-07-28
deprecated it).
