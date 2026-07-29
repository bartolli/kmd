---
name: to-issues
description: 'Break a wiki user story into vertical-slice tracer-bullet checkboxes (or refine existing slices), and in `github`/`gitlab` mode mirror `ready-for-agent` slices to the remote issue tracker with wikilinks back to the story file. Operates on `kind: story` files in the wiki. Quizzes the user on slice granularity, AFK vs HITL, and blocked-by dependencies. Use when the user says "break this story into slices", "refine the slicing", "/to-issues", "post these to GitHub", "publish issues from this story", or wants to validate vertical-slice rules on an existing story.'
metadata:
  version: "0.10.0"
---

# To Issues — Break Stories into Vertical Slices (and Optionally Mirror to GitHub/GitLab)

Take a wiki user story and decompose it into independently-grabbable vertical slices using tracer bullets. In GitHub/GitLab mode, also mirror `ready-for-agent` slices to the remote tracker.

**Hand-off from `/to-prd`:** `/to-prd` writes a rough slice draft (1-3 coarse slices) when synthesizing stories. `/to-issues` is the refinement pass — validates vertical-slice rules, splits coarse slices, sets `blocked_by` dependencies, and mirrors to GH/GitLab. Run `/to-issues` after `/triage` promotes a story to `ready-for-agent`, or earlier if the user wants to refine slicing before triage.

## Prerequisites

- `WIKI_SCOPE: <scope>` declared in the project instructions.
- The target story file exists at `projects/<scope>/plan/<plan-name>/story-N-<slug>.md`.
- `WIKI_ISSUE_TRACKER` declared in the project instructions (`github`, `gitlab`, or `local`).

## What is a vertical slice (tracer bullet)?

A slice is a thin path that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

- Each slice delivers a narrow but COMPLETE path through every layer (schema · API · UI · tests).
- A completed slice is independently demoable or verifiable.
- Prefer many thin slices over few thick ones.

Slices may be **AFK** (autonomous-runnable) or **HITL** (needs human interaction — architectural decision, design review, manual testing). Prefer AFK over HITL where possible.

**Anti-pattern:** "Slice 1: build the schema. Slice 2: build the API. Slice 3: build the UI." That's horizontal — none of those slices is independently demoable. Convert to vertical: "Slice 1: end-to-end happy path. Slice 2: validation rules. Slice 3: error handling."

## Process

### 1. Gather context

- Read the target story file: frontmatter + body (User Story, Scenarios, existing Slices, References).
- Read the parent `plan/plan-{name}.md` for context.
- Read `spec-context.md` for vocabulary; ADRs and specs referenced by the story for technical constraints.
- Check `WIKI_ISSUE_TRACKER` to determine remote-mirror behavior.

### 2. Explore the codebase (optional)

If you haven't already explored, do so to understand the current state of code. Slice titles and descriptions should use the project's domain glossary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Walk the story's scenarios and propose slices. Each slice should:

- Cover one or more scenarios end-to-end (NOT one per scenario by default — group related scenarios where they share infrastructure)
- Pass the vertical-slice test: independently demoable
- Be marked AFK or HITL with reasoning

### 4. Quiz the user

Present the proposed slice breakdown as a numbered list. For each slice, show:

- **Title** — short descriptive name
- **Type** — AFK / HITL
- **Blocked by** — which other slices (if any) must complete first
- **Scenarios covered** — which Scenario blocks from the story this addresses
- **Touches** — the relevant `[[spec-X]]` or `[[adr-Y]]`

Ask:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are AFK vs HITL designations correct?

Iterate until the user approves.

### 5. Write the slice list to the story body

Replace the story's `## Slices` section with the approved list:

```markdown
## Slices

- [ ] **Slice 1** — Cart accepts checkout request and 200s for valid cart · `AFK` · covers: Scenario 1 · [[spec-cart-model]]
- [ ] **Slice 2** — Empty-cart guard returns 400 with structured error · `AFK` · covers: Scenario 2 · [[spec-cart-model]]
- [ ] **Slice 3** — Invalid-token rejection (auth check) · `AFK` · covers: Scenario 3 · [[adr-auth-token]]
```

Update `updated:` in story frontmatter.

### 6. Update blocked_by relationships

If any slice in this story depends on a slice in another story, update the dependent **story's** `blocked_by:` frontmatter array (not the slice — slices live inside stories, dependencies are tracked at story level for indexability). Example:

```yaml
blocked_by: [story-1-customer-can-add-items]
```

### 7. Mirror to remote (GitHub/GitLab mode only)

For **each slice currently marked `ready-for-agent`** at the story level (`triage_state: ready-for-agent` in frontmatter), create one remote issue. Skip slices in stories that aren't ready-for-agent yet — they go remote when `/triage` promotes them.

**GitHub:**

```bash
gh issue create \
  --title "<Story title> — Slice N: <slice title>" \
  --body "<see body template below>" \
  --label "ready-for-agent,enhancement"
```

**GitLab:**

```bash
glab issue create \
  --title "<Story title> — Slice N: <slice title>" \
  --description "<see body template below>" \
  --label "ready-for-agent,enhancement"
```

**Issue body template (lifted from Matt's pattern, adapted to wiki):**

```markdown
> *This was generated by AI during triage.*

## Parent

Story: [story-N-<slug>](<github-link-to-vault-or-wiki-search>)
Plan: [plan-<name>](<...>)

## What to build

<concise description of this vertical slice — end-to-end behavior, not layer-by-layer>

## Acceptance criteria

- [ ] <derived from Scenario covered>
- [ ] <derived from Scenario covered>

## Touches

- [[spec-X]] / [[adr-Y]] (referenced from the story)

## Blocked by

- <link to blocking remote issue, or "None — can start immediately">

## Wiki canonical

This issue mirrors slice N of [story-N-<slug>](<vault-path>). The wiki story file is the source of truth for slice state and acceptance criteria.
```

### 8. Update the parent plan's references

If new ADRs/specs were created during slice refinement, add them to the parent plan's `## References` section.

### 9. Confirm the resync

Harnesses with the posttool hook validate and sync automatically. Check `kmd config`: if the `synced` line did not advance past your edits, the hook is not wired — run `kmd validate`, fix findings, then `kmd sync`.

### 10. Done

Report:

- N slices written to `[[story-N-<slug>]]`.
- M slices mirrored to <github|gitlab> (if in remote mode).
- Next step: `/triage` if the story isn't `ready-for-agent` yet, or `/tdd` if it is.

## Anti-pattern detection

Before proposing slices, scan the story for these horizontal-slice signals and refuse to write them:

- **Layer-named slices** ("Slice 1: schema", "Slice 2: API", "Slice 3: UI") → flag and convert to vertical.
- **"Refactor X" or "Set up Y" slices without a behavior change** → flag; either skip (it's not a slice) or fold into a real slice.
- **Slices that can't be demoed** → not a slice. Find the smallest demoable unit.

If you can't break a story into 1-5 vertical slices, the story is too coarse — suggest splitting the story before slicing.

## Rules

- **Do not slice without confirming with the user.** Quiz first; iterate; then write.
- **Prefer AFK over HITL.** Push back if the user marks something HITL without a clear reason.
- **In remote mode, the wiki story file remains canonical.** GH/GitLab issues mirror slice work but state lives in story frontmatter.
- **Blocked-by lives at story level, not slice level** — for indexability and to avoid stale references when slices re-cut.
- **Confirm the resync after edits** — the posttool hook syncs automatically; if `kmd config`'s `synced` line did not advance, run `kmd validate` then `kmd sync`.
- **Lead remote comments with the AI disclaimer** in GH/GitLab mode.
- **Quote prose-bearing frontmatter scalars** to avoid breaking the sync walker.
