# CLAUDE.md — vault-infra

Tooling monorepo for the llm-wiki: Postgres schema, vault → PG sync, and the `wiki-mcp` stdio server. The vault itself is a separate git repo at `../vault/`. Full system blueprint at `../README.md`.

## Stack

- Node.js 22+, pnpm workspace
- TypeScript strict (`tsconfig.base.json`) — NodeNext, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- Biome for lint + format
- Vitest for tests
- Pino for structured logging — stderr + `~/.local/state/wiki-mcp/server.log` via multistream
- Zod for env config and MCP tool input schemas

## Monorepo shape

| Package | Name | Role |
|---|---|---|
| `packages/db` | `@llm-wiki/db` | Postgres schema (`schema.sql`). `pnpm --filter @llm-wiki/db apply` runs `psql $WIKI_DB < schema.sql`. |
| `packages/cli` | `@llm-wiki/cli` | `wiki` CLI. `wiki sync` is the vault → PG one-way sync (walks `projects/`, `research/`, `notes/`; skips `raw/`, `templates/`); `validate`/`export` land in later slices. See [[adr-infra-cli]]. |
| `packages/mcp` | `@llm-wiki/mcp` | `wiki-mcp` stdio server. Two tools: `prime` and `search`. |

`@llm-wiki/shared` is **not** extracted yet — the frontmatter parser and PG client are inline in `@llm-wiki/cli`. Lift to `shared/` only when a third *separate* consumer materializes (YAGNI); `validate`/`export` share them in-package.

## Commit discipline

- Commit prefix pattern: `{type}(phase-{N}): {summary}` — e.g. `feat(phase-3): markdown primer output`.
- Before any commit: `pnpm typecheck` green **and** the relevant package's test suite green.
- **Never hand-edit version pins** in `package.json`. Always `pnpm add [-D] [--filter <pkg>] <dep>` — the lockfile is the source of truth.
- Prefer a new commit over `--amend`. Never `--no-verify`.

## Canonical commands

```bash
# Workspace-wide:
pnpm -r run typecheck
pnpm -r run test
pnpm lint

# Apply Postgres schema (destructive — drops public schema):
psql "$WIKI_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pnpm --filter @llm-wiki/db apply

# Run the sync (vault → PG):
pnpm --filter @llm-wiki/cli start          # = wiki sync

# Inspect:
psql "$WIKI_DB" -c "SELECT path, title, kind, scope, topic FROM pages;"
```

## Architectural principles (non-negotiable)

See the `/ts-architect` skill for full rationale. Applied here:

- **Thin tools, fat domain.** MCP tool handlers validate input, call domain functions, serialize output. Domain code must be testable without starting an MCP server.
- **Transport separation.** Blueprint §10 specifies stdio-only, but the server core still does not import the transport — `bin/stdio.ts` wires it.
- **Fail loud at startup.** Validate all env vars (`WIKI_VAULT`, `WIKI_DB`) with Zod at process start; crash on invalid. Structured MCP errors at runtime; never crash on a bad tool call.
- **One Zod schema, three purposes.** Tool input schemas defined once, used for MCP registration, runtime validation, and `z.infer<>` types.
- **Named exports only. No default exports. No barrel files.** Enforced by Biome (`noDefaultExport`, `useImportType`).
- **Path is authoritative for `scope` / `topic`.** Sync derives them from the relative path (`projects/{scope}/...`, `research/{topic}/...`); frontmatter is descriptive, not source-of-truth.
- **Secrets never touch source.** `WIKI_DB` connection strings live in the shell env, never in committed files.

## MCP tool rules

Blueprint §10 freezes the contract:

- **Launch the stdio server with `pnpm --dir <abs-path-to-vault-infra> exec tsx packages/mcp/bin/stdio.ts`.** This is what `../.mcp.json` invokes. `--dir` makes pnpm find the workspace regardless of caller cwd (Claude Code's spawn does not reliably honor the JSON `cwd` field). `pnpm run` / `pnpm start` / `pnpm --filter <pkg> <script>` are wrong choices — they emit a script banner on stdout that breaks the JSON-RPC handshake.
- **Server logs land in `~/.local/state/wiki-mcp/server.log`.** `src/lib/diag.ts` writes raw startup checkpoints synchronously (survives pre-pino crashes); `src/lib/logger.ts` fans pino out to both stderr and the same file. Tail it (`tail -f ~/.local/state/wiki-mcp/server.log`) when debugging spawn issues — Claude Code's `mcp-logs-<server>/*.jsonl` only captures stderr that arrives before the connection closes, unreliable for fast-fail crashes.
- **Two tools total in the hot path:** `prime(scope, task?)` and `search(query, scope?, kind?, limit?)`. Do not add a third without an explicit blueprint amendment.
- **Templates are MCP resources, not tools.** URI scheme: `wiki://template/{domain}/{kind}` (e.g. `wiki://template/project/adr`); `wiki://template/note` is the single-segment exception because notes have only one kind. `resources/list` enumerates all 10; `resources/read` returns the template body fresh from disk on every call. Registration lives in `src/resources/templates.ts`.
- **`prime` returns markdown** in `content[].text` (~20% token savings vs JSON syntax tax) plus the same data as `structuredContent` JSON. Empty sections (Active Decisions, Current Plan, Hubs, Recent, Cross-scope, Relevant) are omitted to keep the surface lean.
- **`search` returns ranked candidates as JSON** — `{path, title, kind, summary, score}`. **Never full page bodies.** The agent opens files directly via filesystem.
- **No write tools.** The agent writes markdown directly to the vault; the sync propagates changes to PG.
- **Error protocol:** return `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] }`. Never throw from a tool handler — catch and structure.

## Don'ts

- Don't write SQL in tool handlers — the domain layer mediates.
- Don't add tools beyond the two specified — see MCP tool rules.
- Don't use `console.log()` anywhere in the MCP server — stderr only (Pino).
- Don't add scope: no features, abstractions, tests, or config beyond the task.
- Don't use memory (`~/.claude/projects/…/memory/`) for phase-specific state — blueprint phases are the state.
