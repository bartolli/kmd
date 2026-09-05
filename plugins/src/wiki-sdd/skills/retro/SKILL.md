---
name: retro
description: This skill should be used for a session retrospective at any point in a session — mid-session when drift is suspected, after a bug-hunting detour, after compaction, before a release cut, and always before /handoff. Asks three questions — 'What are you least confident about?', 'What's the biggest thing we're missing? What don't I realize?', and 'Where are we relative to the slice we started, and what were the detours?' — then routes every answer into a fix in the current commit when it is small and testable, else intents, sightings bumps, and story Decisions entries — never a new story and never the primer. Use when the user says "/retro", "run the retro", "lightweight retro", "mid-session retro", "session retro", "retro protocol", "check for drift", "what are we least confident about", "what are we missing", or "what don't you realize".
---

# Retro — Three Questions, Then Intents

## Why this exists

The session that did the work is the worst judge of its own blind
spots and the last to notice its own drift. Verification gates check
what the session claimed; the retro asks what it did not claim, and
whether the work still points at the slice it started on. It is a
grooming step, cheap enough to run whenever drift is suspected, not a
closing ceremony: it fixes what the hot context can fix, files intents
for what it cannot, never a story, and it never touches the primer. The session close is `/handoff`, which is gated on
a retro newer than the primer.

Precedent: a mid-session retro surfaced that a just-shipped
containment check was looser than its intent and that a fail-closed
gate needed a second edge kind. No gate would have caught either,
because no claim covered them.

## Prerequisites

- `WIKI_SCOPE: <scope>` declared in the project instructions. If
  missing, suggest `/wiki`.
- The `intent` kind served: `wiki://template/project/intent` via MCP,
  or `kmd resource wiki://template/project/intent` where the harness
  exposes no MCP resources.
- The scope's `notes/` folder for the dated retro note
  (`projects/<scope>/notes/retro-YYYY-MM-DD.md`).

## When it runs

- Any time drift is suspected: a bug-hunting detour, an hour without
  touching the slice in progress, a compaction, a topic change.
- Before a release cut, and before `/handoff` — the handoff gate blocks
  a primer write until a retro note is newer than the primer.
- The operator invokes it. The context clock may prompt it; the agent
  never runs it unasked.

## The protocol

### Step 1 — Re-read ground truth

Before answering anything, re-read the story and slice in progress
from disk, and list the scope's open intents:

- MCP: `search(query, scope=<scope>, kind="intent")`;
  CLI: `kmd search "<terms>" --scope <scope> --kind intent`.

The re-read is the point. A degraded context cannot diagnose its own
drift by introspection; reading the contract back is the cheapest
refresh there is.

### Step 2 — Answer three questions

In order, in the visible response:

1. **What are you least confident about right now?**
2. **What's the biggest thing we're missing about the situation right
   now? What don't I realize?**
3. **Where are we relative to the slice we started?** State the delta
   between the slice's acceptance and what is in the tree, citing the
   slice by name and its tick state. Then name every detour since the
   last retro and classify each: *decision* (recorded where), *drift*
   (dropped, or worth an intent), or *done*.

Answering rules:

- Answers are about the WORK, not the worker. Name code, artifacts,
  and measurements — never feelings, apologies, or process narrative.
- Every answer to questions 1 and 2 carries a location (file, story,
  intent, number) and a falsification path: what a future session runs
  or reads to confirm or kill the concern.
- Question 2 demands the perspective shift: re-read the session's own
  claims as a skeptic. What blind spot did every gate share? What
  would an adversarial reviewer probe first? What state does the
  session assume persists that nothing actually verifies?
- Banned: performative humility ("mistakes may have been made"),
  vacuous confidence ("everything is verified"), and re-announcing
  filed intents or stories as discoveries — reference them instead.
- An answer that only references existing intents and stories is a
  valid answer. A retro that files nothing new is a passing retro.

### Step 3 — Route each answer

Nothing stays only in chat. Route by shape:

| Answer shape | Artifact |
|---|---|
| Finding already on file — an intent in any status, or a story | Bump the intent's `sightings` and its `updated`; for a story, reference it. Never file a twin. |
| New finding whose fix is small, testable now, and outside ADR-gated territory | The fix itself, in the current commit: a test named for the finding, then the change; one Decisions line in the owning story naming it. No intent. |
| New finding that needs investigation, a decision, a cold session, or more than a small change | An intent: `status: draft`, `origin: retro`, `sightings: 1`, the six template sections, about fifteen lines, a concrete Falsification path. |
| Invalidated or shaky assumption | Correct the story, spec, or ADR where it lives, inline; a Decisions entry in the story if acceptance changes. |
| Sequencing call or risk that shapes what ships next | A Decisions entry in the owning story, carrying its falsification path. |
| A detour from question 3 | Decision → its recorded location; drift → dropped, or an intent if it is worth pursuing; done → the slice tick. |

Rules of the table:

- **Cap: at most three new intents per retro.** With more findings,
  file the three with the sharpest falsification paths and name the
  rest as unfiled in the retro note. If one matters it recurs, and the
  second sighting is what earns it a file.
- **Two strikes before elaboration.** The retro never writes a story.
  Promotion — two sightings, a confirmed falsification, or an operator
  call — is `/triage`'s outcome, and the story is written there.
- **Never** a new story, a session log in the plan, or a primer edit.
  The plan carries only its Story Index; the primer is `/handoff`'s.

### Step 4 — The retro note

One note per day at `projects/<scope>/notes/retro-YYYY-MM-DD.md`, no
`kind` field, `updated` taken from `date -u +%Y-%m-%dT%H:%M:%SZ`. Each
invocation appends a section headed by the UTC time and a label:

```markdown
## 14:30Z — mid-session, resolver

- Intents: [[intent-<slug>]] filed; [[intent-<other>]] sightings → 2
- Decisions: [[story-<slug>]] § Decisions, sequencing of the engine publish
- Detours: <one line each, classified>
- Unfiled: <one line each, if any>
```

Ten lines or fewer, pointers only. The substance lives in the intents
and stories; the note is the freshness signal the handoff and tag
gates read, so its clock must move every time.

### Step 5 — Acting on a finding: fix now, or file

The intent is a cold-start capture: its six sections hold what a
future session cannot recover from the code. When the context is hot
and the fix is small, the interview re-captures what the conversation
already holds and charges the next session for work this one could
have finished. Fixing is the default and filing the fallback. Fix now
when all three hold:

1. **Small and testable.** The change is bounded — on the order of
   twenty lines — and a test named for the finding goes red before it,
   in a test file already in play. The test is the contract; the
   record is one Decisions line in the owning story, or `fixed_by` on
   an intent already filed.
2. **In the current flow.** It ships in the commit the session is
   already building — never its own slice, ceremony, or "next run" —
   and the operator hears what shipped in the same turn: a report, not
   a permission gate. Slice ticks, spec corrections, and the retro note
   ride the same session.
3. **Unlocked territory.** Anything the story's Decisions mark as
   ADR-gated routes to its amendment round. When the fix shape IS an
   amendment, acting now means holding that conversation now.

Anything larger files as an intent; when a filed intent's fix turns out
that cheap, it archives with `fixed_by` naming the test's repo-relative
path. Promotion is for findings that need a story's shape.

## Output shape

Visible response: the three answers, each with location and
falsification path; the artifact list (file → what changed); one line
naming what the session is re-anchored on (`story-<slug>`, slice N).
No separate report — the artifacts are the output.

## Anti-patterns

- **Skipping the re-read.** Answering question 3 from memory is the
  drift the question exists to catch.
- **Story from a retro.** A finding is an intent until triage promotes
  it; a story written at filing is the backlog growing by ceremony.
- **Primer from a retro.** The primer is written once, at `/handoff`,
  from the corrected state. A retro that edits it inherits the blind
  spots it was meant to surface.
- **Filing as resolution.** A draft intent is a routed finding, not a
  handled one; the second sighting, not the first file, is the signal.
- **Filing as deferral.** An intent for a fix the hot context could
  make is ceremony charged to the next session, which starts cold and
  pays the interview twice.
- **Confession register.** Wiki artifacts store project state, never
  behavioral postmortems.
- **Note as substance.** A retro note longer than ten lines is a plan
  session log by another name.
