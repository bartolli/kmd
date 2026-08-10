---
name: grill-with-docs
description: Interview-style grilling that captures intent, sharpens vocabulary, and scaffolds wiki structure for a project scope. Use when the user wants to start a new workstream, refine an existing scope's intent, stress-test a plan against the project's domain language, or write a `spec-context.md` (glossary + relationships). Walks one question at a time, recommends an answer for each, and creates artifacts (`index.md`, `primer.md`, `spec-context.md`, lazy ADRs) inline as decisions crystallize. Auto-detects greenfield (scope folder missing → scaffold) vs brownfield (scope exists → refine + cross-reference code). Triggers on phrases like "grill me", "grill the plan", "let's nail down what we're building", "set up a new scope", "refine the intent", or `/grill-with-docs`.
metadata:
  version: "0.15.0"
---

# Grill with Docs

Interview the user relentlessly about every aspect of a project's intent until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies one-by-one. For each question, provide your recommended answer.

Ask one question at a time, waiting for feedback before continuing.

If a question can be answered by exploring the codebase or wiki, explore instead of asking.

## Prerequisites

Before grilling, the project must declare `WIKI_SCOPE: <scope>` in its project instructions (`CLAUDE.md`, `AGENTS.md`, or equivalent). If missing, suggest `/wiki` first and stop.

## Mode detection

Read `projects/<scope>/index.md` in the vault:

- **Greenfield** — file does not exist. Scaffold the scope from scratch (intent capture → identity → primer stub → methodology → vocabulary → lazy ADRs).
- **Brownfield** — file exists. Refine intent, cross-reference code (if any), surface contradictions between user's stated model and code/spec reality, sharpen `spec-context.md` and ADRs as the conversation reveals them.

Announce the mode you're running in before starting.

**New-scope guardrail:** if `<scope>` is not in `vault.yaml`'s `scopes:` field, STOP. New scopes need explicit user approval. Surface the current scope list and ask.

## Greenfield flow

### Step 1 — Identity (lands in `index.md`)

Collect, one question at a time:

- **Title** — What does this project deliver, in one phrase? (Recommend: short, noun-phrase form, e.g. "Operations system for a food truck")
- **Summary** — What is it, in one or two sentences? (Recommend: extract from the user's first description; show your draft.)
- **Methodology** — `sdd` (spec-driven), `tdd` (test-driven), or `hybrid`? (Recommend `hybrid` for app-layer work, `sdd` for spec-heavy or contract-first work, `tdd` when the surface is mostly behavior-discoverable. State your reasoning per project.)
- **Phase** — what number? (Recommend `0` for greenfield, `1` if a working prototype exists.)
- **Tags** — pick 3-6 from existing `top_tags` if `prime(<scope>)` is callable; otherwise propose new ones with justification.

Write `projects/<scope>/index.md` in the vault using the `wiki://template/project/index` resource. Frontmatter only — body can be a single line summary. Do not invent fields outside the schema.

### Step 2 — Primer stub (lands in `primer.md`)

Primer is **co-authored**. Don't invent prose. Create a stub:

```markdown
---
created: "<today>"
updated: <today>
---

# <Title>

## Current Focus

<one to three sentences — agreed with user>

## Open Questions

- <question 1>
- <question 2>

## Blocked On

- <none, or specifics>
```

Use `wiki://template/project/primer` for the canonical shape. `created` is **write-once** — set it at creation and never bump it; only `updated` changes on later edits. Optional sections (Load-bearing invariants, Read Order, Working set) are added later as they earn their place.

### Step 3 — Vocabulary (lands in `spec/spec-context.md`, **lazy creation**)

As the user describes the system, watch for:

- **Domain terms** — words that map to specific concepts in this project (`Order`, `Lot`, `Customer`, `Cart`, `Migration`)
- **Synonym conflicts** — same concept, multiple words ("cancellation" vs "void" vs "refund")
- **Overloaded terms** — same word, multiple meanings ("account" = `Customer` or `User`?)

When the **first term gets resolved**, create `projects/<scope>/spec/spec-context.md` in the vault using `wiki://template/project/spec`. Body shape:

```markdown
# <Scope> — Domain Context

<One to two sentences: what this domain is and why it exists.>

## Language

**Term1**:
A concise definition (one sentence).
_Avoid_: aliases that shouldn't be used.

**Term2**:
A concise definition.
_Avoid_: aliases.

## Relationships

- A **Term1** has one or more **Term2**.
- A **Term2** belongs to exactly one **Term1**.

## Example dialogue

> **User:** "When a Customer places an Order, do we create the Invoice immediately?"
> **Domain expert:** "No — an Invoice is only generated once a Fulfillment is confirmed."

## Flagged ambiguities

- "account" was used to mean both **Customer** and **User** — resolved: distinct concepts.
```

Update `spec-context.md` **inline** as more terms resolve. Don't batch.

**Vocabulary rules:**

- Be opinionated. Pick one canonical term per concept; list aliases under `_Avoid_`.
- Keep definitions tight. One sentence max. Define what it IS, not what it does.
- Only include terms specific to this project. General programming concepts (timeouts, retries, error types) don't belong.
- Group terms under subheadings only when natural clusters emerge.

### Step 4 — Lazy ADRs (`adr/adr-{topic}.md`)

Only offer to create an ADR when **all three** are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons.

If any of the three is missing, skip the ADR.

Use `wiki://template/project/adr`. Body shape:

```markdown
# <Title>

## Status

active

## Context

What forced this decision? What constraints applied?

## Decision

The decision in one sentence, then a short paragraph elaborating.

## Rationale

Why this option over the alternatives. Reference the alternatives by name.

## Consequences

What becomes easier. What becomes harder. What knock-on effects exist.

## Alternatives considered

- **Alternative A** — why rejected.
- **Alternative B** — why rejected.
```

### Termination

The greenfield grill is done when:

1. `index.md` exists with methodology declared.
2. `primer.md` exists (stub at minimum, with Current Focus and at least one Open Question or "none").
3. `spec-context.md` exists IF any domain terms were resolved (skip if the conversation was about pure infrastructure with no project-specific vocabulary).
4. At least one ADR exists IF a hard-to-reverse decision surfaced. Skip if none did.

State the termination explicitly when reached:

> "Scaffold complete. Run `prime(<scope>)` to verify orientation. Next steps: `/to-prd` if you want to draft a workstream from this conversation, or just start working in the project — the wiki will catch up via `/grill-with-docs` again later."

## Brownfield flow

### Step 1 — Orient

- Run `prime(<scope>)` via the wiki MCP to load identity, primer, active ADRs.
- Read `spec-context.md` if it exists.
- Read recent ADRs and the current plan.

### Step 2 — Cross-reference code

Walk the codebase using the project's domain glossary. Look for contradictions:

- Code uses a term that conflicts with `spec-context.md` Language section → flag it.
- Code structure implies a relationship the user didn't mention → ask.
- Spec says X happens but code does Y → surface the contradiction.

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: *"Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"*

### Step 3 — Refine

Based on the conversation:

- **New term** → add to `spec-context.md` Language section inline.
- **Term redefinition** → update Language entry; add a "Flagged ambiguities" entry recording the change.
- **Hard-to-reverse decision** → offer an ADR per the three-test.
- **Spec correction** → land it inline in the relevant `spec/spec-{topic}.md`. Don't queue corrections in the plan — that creates doc-debt.
- **Open question resolved** → strip from primer; reflect resolution in the relevant ADR or spec.

### Step 4 — Update primer (only when explicitly asked)

Per vault rules, primer is co-authored. Suggest changes; don't write them silently. If the user agrees, update `Current Focus`, `Open Questions`, `Blocked On`. Strip stale Read Order / Working set entries.

### Termination

The brownfield grill is done when:

1. All flagged ambiguities are resolved or explicitly deferred.
2. New domain terms are captured in `spec-context.md`.
3. Hard-to-reverse decisions have ADRs.
4. Code/spec contradictions are either fixed in the spec or recorded as known divergences.

## Rules

- **Ask one question at a time.** Wait for the user's answer. Provide a recommended answer with reasoning for each.
- **If a question can be answered by reading code or wiki**, do that instead of asking.
- **Never invent scopes outside `vault.yaml`.** Stop and ask if the user names a new scope.
- **Don't write `primer.md` prose without user approval.** Stub headers are fine; narrative is co-authored.
- **Update `spec-context.md` inline**, not in batches.
- **Skip ADRs unless all three tests pass.** Most decisions don't deserve one.
- **Always update frontmatter `updated:` field** on any edit.
- **Keep questions concrete.** "What's the methodology?" is fine; "How should we approach this?" is too vague.
- **Quote prose-bearing frontmatter scalars** in YAML — `summary: "..."` — to avoid breaking the sync walker.

## Reference files

- [questions-cookbook.md](questions-cookbook.md) — common grilling questions per scaffolding stage with recommended answers
