---
name: "wiki-sdd"
displayName: "Wiki SDD"
description: "Wiki-native spec-driven development loop for an Obsidian-based agent wiki: bootstrap a project scope, grill intent into specs, synthesize PRDs and user stories, triage work, slice into tracker issues, implement with TDD, and close sessions with retrospectives."
keywords: ["wiki", "spec-driven development", "sdd", "prd", "user stories", "triage", "tdd", "agent wiki", "obsidian", "kmd", "grill"]
author: "Angel Bartolli"
---

# Wiki SDD

A workflow loop for spec-driven development on top of an Obsidian-based agent wiki, served by the `wiki` MCP server (`@bartolli/kmd`). The wiki is the canonical cross-session memory: project scopes, specs, ADRs, plans, and user stories live there; these workflows read and write it. Two MCP tools carry the traffic: `prime(scope, task?)` for orientation at session start, `search(query, scope?, kind?, limit?)` for retrieval.

## Onboarding

1. Verify Node.js ≥ 22 and `npx` are available.
2. The bundled `mcp.json` starts the server with `npx @bartolli/kmd mcp`, resolving the vault root from the `WIKI_VAULT` environment variable. If `WIKI_VAULT` is not set for the Kiro process, ask the user for their vault's absolute path and either have them export `WIKI_VAULT`, or append the path as a final entry in `args` of the installed `mcp.json`.
3. If the user has no vault yet, read and run the `wiki` workflow — it scaffolds a working vault (`vault.yaml`, the served `templates/`, domain dirs) and wires the current project to it.
4. Verify the connection: call `prime` with a scope from the vault's `vault.yaml`. The server is fail-loud — a clear error naming valid scopes also proves it is running.

## Workflows

Every steering file carries `inclusion: auto` frontmatter — Kiro loads it automatically when the request matches its description, the same way a skill triggers. The index below is the manual fallback: to load one explicitly,

Call action "readSteering" with powerName="wiki-sdd", steeringFile="<file>"

| Steering file | Run it when |
|---|---|
| `wiki.md` | Wiring a project to the wiki, or bootstrapping a brand-new vault. The constellation hub — start here. |
| `grill-with-docs.md` | Nailing down intent for a new or existing scope; writing `spec-context.md`. |
| `to-prd.md` | Turning an established discussion into a plan with user-story files. |
| `triage.md` | Moving user stories through the triage state machine. |
| `to-issues.md` | Slicing stories into vertical tracer-bullet checkboxes; mirroring to GitHub/GitLab. |
| `tdd.md` | Implementing a single `ready-for-agent` slice red-green-refactor. |
| `retro.md` | Closing a session: two retro questions, then the primer resync. |
| `signal-dense.md` | Long technical threads that need canonical-vocabulary output discipline. |

Typical arc for new work: grill-with-docs → to-prd → triage → to-issues → tdd (per slice) → retro before the closing primer resync.

## Bundled support files

Each workflow's support files sit in a sibling directory named after it, at the power root: `wiki/references/` (vault.yaml schema and the new-vault structure scaffold), `wiki/templates/` (project-instructions and MCP-entry templates), `grill-with-docs/questions-cookbook.md` (interview question bank).

The steering files and support directories are generated from the canonical skill sources — edit upstream, not here.
