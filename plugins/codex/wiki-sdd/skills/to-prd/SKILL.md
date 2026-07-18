---
name: to-prd
description: 'Synthesize the current conversation context into a wiki-native plan with child user-story files. Writes a thin `plan/plan-{name}.md` (Problem · Solution · Story Index · Out of Scope · References) plus one `plan/{name}/story-N-{slug}.md` per user story, each with Gherkin scenarios and an initial slice list. Default `triage_state: needs-triage`. Does NOT interview — assumes the conversation already established intent (typically via `$grill-with-docs`). Use when the user says "turn this into a plan", "draft a PRD", "$to-prd", "write up what we discussed", "synthesize this into stories", or similar synthesis requests after a working discussion. Reads `spec-context.md` and existing ADRs to use the project''s vocabulary correctly.'
---

# To PRD — Synthesize Conversation into a Wiki-Native Plan

Takes the **current conversation context** and produces a thin orchestration plan plus per-story files in the wiki. Does not interview — synthesizes what you already know. If intent isn't clear, suggest `$grill-with-docs` first and stop.

## Prerequisites

- `WIKI_SCOPE: <scope>` declared in the project instructions. If missing, suggest `$wiki` and stop.
- `projects/<scope>/index.md` exists. If missing, suggest `$grill-with-docs` and stop.
- The conversation has discussed a concrete piece of work (a feature, a refactor, a phase). If only abstract intent has been discussed, suggest `$grill-with-docs` to nail it down first.

## What this skill produces

```
projects/<scope>/
├── plan/
│   ├── plan-<name>.md                    ← thin orchestration (~60-100 lines)
│   └── <name>/
│       ├── story-1-<slug>.md             ← Gherkin + slices (~40-60 lines)
│       ├── story-2-<slug>.md
│       └── story-3-<slug>.md
```

Each story file ships with `triage_state: needs-triage`. The user runs `$triage` next to evaluate readiness.

## Process

### 1. Read the wiki context

- Call `prime(<scope>)` via the wiki MCP — get identity, primer, active ADRs, top tags, current plan.
- Read `projects/<scope>/spec/spec-context.md` if it exists — use canonical vocabulary throughout.
- Read recent ADRs under `projects/<scope>/adr/` to respect existing decisions.
- Note any active plan — the new plan should not duplicate an in-flight one.

### 2. Synthesize (do not interview)

From the conversation, extract:

**Plan slug** — kebab-case, descriptive, ≤4 words. e.g. `billing-mvp`, `void-and-amend`, `auth-rewrite`. The slug becomes both the parent file (`plan-{slug}.md`) and the sub-folder (`{slug}/`).

**Problem** — 1-3 sentences from the user's perspective. Use vocabulary from `spec-context.md`. If you can't write this without inventing, the conversation hasn't established the problem — stop and suggest `$grill-with-docs`.

**Solution** — 2-3 sentences describing the approach. Reference existing specs/ADRs by wikilink (`[[spec-cart-model]]`, `[[adr-postgres]]`).

**User stories** — extract from the conversation. Each story:

- Has a clear actor, capability, benefit
- Maps to a discrete piece of user value
- Will fit in 1-5 vertical slices

If you can identify <3 stories, the workstream may be too small. Two paths: (a) still create the parent `plan-{slug}.md` + `{slug}/` sub-folder + the 1-2 story files — architectural consistency wins (skills downstream don't have a special-case path), or (b) skip the plan entirely and write a single standalone story under an existing related plan. Default to (a) unless the user prefers (b).

If you can identify >12 stories, the workstream is too large for one plan — propose splitting into multiple plans (`plan-billing-foundation` + `plan-billing-rollout`).

**Out of Scope** — 3-5 bullets capturing things explicitly *not* part of this plan. Lift these from the conversation.

### 3. Identify spec/ADR gaps

Walk the synthesized plan and ask:

- Does the solution describe a system that doesn't yet have a `spec-{topic}.md`? → propose creating one.
- Does the solution rely on a hard-to-reverse decision not yet captured in an ADR? → propose creating one (apply Matt's three-test: hard-to-reverse + surprising + real trade-off).

Don't write specs/ADRs in this skill — flag the gaps and reference future skill work. Or, if the gap is small enough to fill inline (a single new term in `spec-context.md`), do it now.

### 4. Write the parent plan

Write `projects/<scope>/plan/plan-<slug>.md` using `wiki://template/project/plan` as the frontmatter base, with body:

```markdown
# <Plan Title>

## Problem

<1-3 sentences from the user's perspective.>

## Solution

<2-3 sentences. Reference [[spec-X]] and [[adr-Y]] by wikilink.>

## Stories

| # | Story | State | Category |
|---|---|---|---|
| 1 | [[story-1-<slug-1>]] | needs-triage | enhancement |
| 2 | [[story-2-<slug-2>]] | needs-triage | enhancement |
| 3 | [[story-3-<slug-3>]] | needs-triage | enhancement |

## Out of Scope

- <bullet 1>
- <bullet 2>
- <bullet 3>

## References

- [[spec-context]] — vocabulary
- [[spec-<topic>]] — system overview
- [[adr-<decision>]] — relevant decision
```

Frontmatter:

```yaml
---
title: <Plan Title>
kind: plan
scope: <scope>
status: active
summary: "<one-sentence summary>"
tags: [...]
created: "<today>"
updated: <today>
---
```

### 5. Write each story file

For each user story, write `projects/<scope>/plan/<slug>/story-N-<story-slug>.md` using `wiki://template/project/story`. Body:

```markdown
# <Story Title>

## User Story

As a <actor>, I want <capability>, so that <benefit>.

## Scenarios

**Scenario: <happy path name>**
- Given <precondition>
- When <action>
- Then <expected outcome>

**Scenario: <edge case name>**
- Given <precondition>
- When <action>
- Then <expected outcome>

## Slices

- [ ] **Slice 1** — <description> · `AFK` · [[spec-<related>]]
- [ ] **Slice 2** — <description> · `AFK` · [[adr-<related>]]

## References

- [[spec-<related>]]
- [[adr-<related>]]
```

Frontmatter:

```yaml
---
title: <Story Title>
kind: story
scope: <scope>
parent: plan-<slug>
status: active
triage_state: needs-triage
category: enhancement
blocked_by: []
tags: [...]
sources: []
created: "<today>"
updated: <today>
---
```

**Rules for scenarios:**

- Each scenario describes ONE behavior end-to-end.
- Use Given/When/Then, not free-form prose.
- Cover the happy path first, then 1-2 edge cases per story.
- Don't try to be exhaustive — the user can add scenarios during `$triage` if a story needs more clarity.

**Rules for slices:**

- A slice is a tracer-bullet **vertical** through every layer (schema · API · UI · tests).
- Each slice should be independently demoable.
- Mark each slice `AFK` (autonomous-runnable) or `HITL` (needs human judgment).
- Default to AFK — push back if a user describes a slice that requires unavoidable human judgment.
- 1-5 slices per story is normal. If a story needs 6+, the story is too coarse — split it.

**Slice ownership across skills:** `$to-prd` writes a *rough* slice draft (1-3 slices, coarse, mostly to ground the story shape). `$to-issues` is the refinement pass — it validates vertical-slice rules, splits coarse slices into proper tracer bullets, sets `blocked_by` between stories, and (in GH/GitLab mode) mirrors `ready-for-agent` slices to remote issues. Don't over-invest in slice quality here; that's `$to-issues`'s job.

### 6. Sync the wiki

After writing, sync the index:

```bash
kmd sync
```

This makes the new plan and stories searchable via `prime` and `search`.

### 7. Done — suggest next step

> "Wrote `plan-<slug>` with N stories, all at `needs-triage`. Run `$triage` to evaluate readiness and move stories to `ready-for-agent` (AFK) or `ready-for-human`."

## Rules

- **Do not interview.** Synthesize from conversation. If intent is unclear, suggest `$grill-with-docs`.
- **Do not auto-trigger `$triage`.** Stories ship at `needs-triage` and wait for the user to invoke triage explicitly.
- **Use canonical vocabulary** from `spec-context.md`. Don't invent terms.
- **Reference existing specs and ADRs** via wikilinks rather than restating their content.
- **One story file per user story.** Even if a story has just one slice, it gets its own file (architectural consistency).
- **Quote prose-bearing frontmatter scalars** (`summary: "..."`) to avoid breaking the sync walker.
- **Do not write specs or ADRs** in this skill — flag gaps and let `$grill-with-docs` fill them.
- **Update plan/story `updated:` field** after every edit.
- **Set `created` once at creation; never bump it** — only `updated` changes on later edits.
