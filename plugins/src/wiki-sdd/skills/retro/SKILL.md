---
name: retro
description: This skill should be used for a session retrospective at any point in a session — mid-session when drift is suspected, after a bug-hunting detour, after compaction, before a release cut, and always before /handoff. Asks three questions — 'What are you least confident about?', 'What's the biggest thing we're missing? What don't I realize?', and 'Where are we relative to the slice we started, and what were the detours?' — then works each finding while the context is hot — fixes it, prepares it up to the operator's approval, or asks — and files an intent only for what is blocked, with the blocker named — never a new story and never the primer. Use when the user says "/retro", "run the retro", "lightweight retro", "mid-session retro", "session retro", "retro protocol", "check for drift", "what are we least confident about", "what are we missing", or "what don't you realize".
---

# Retro — Three Questions, Then the Work

## Why this exists

The session that did the work is the worst judge of its own blind
spots and the last to notice its own drift. Verification gates check
what the session claimed; the retro asks what it did not claim, and
whether the work still points at the slice it started on.

A retro is judged by what is true when it ends, not by what it wrote
down. Right now the code is open, the measurements are fresh, and the
operator is present. A finding filed for later is paid for twice: this
session describes it, and a cold session rebuilds what this one already
knew before it can start. So the product of a retro is findings closed.
An intent is what is left when a finding cannot be closed here, and it
says what stopped it.

It is a grooming step, cheap enough to run whenever drift is suspected,
not a closing ceremony. The session close is `/handoff`, which is gated
on a retro note newer than the primer.

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
- When the operator asks for it. The context clock may prompt one; say
  so and let the operator decide, because a retro changes project
  state.

## Re-read ground truth

Before answering anything, re-read the story and slice in progress
from disk, and list the scope's open intents:

- MCP: `search(query, scope=<scope>, kind="intent")`;
  CLI: `kmd search "<terms>" --scope <scope> --kind intent`.

The re-read is the point. A degraded context cannot diagnose its own
drift by introspection; reading the contract back is the cheapest
refresh there is.

## Answer three questions

In order:

1. **What are you least confident about right now?**
2. **What's the biggest thing we're missing about the situation right
   now? What don't I realize?**
3. **Where are we relative to the slice we started?** State the delta
   between the slice's acceptance and what is in the tree, citing the
   slice by name and its tick state. Then name every detour since the
   last retro and classify each: *decision* (recorded where), *drift*,
   or *done*.

What makes an answer useful:

- It is about the work, not the worker. Name code, artifacts, and
  measurements; leave out feelings, apologies, and process narrative.
- Each answer to questions 1 and 2 carries a location (file, story,
  intent, number) and a falsification path: what someone runs or reads
  to confirm or kill the concern. Where that check is cheap, run it
  before answering and report the result instead of the concern.
- Question 2 asks for a change of seat: re-read the session's own
  claims as a skeptic. What blind spot did every gate share? What would
  an adversarial reviewer probe first? What state does the session
  assume persists that nothing verifies?
- An answer that only points at existing intents and stories is a valid
  answer. Reference them; do not announce them again as discoveries.

## Work each finding

Each concern from questions 1 and 2, and each drift from question 3, is
a finding. Take the most consequential first and carry each one as far
as this session can. Use the first of these that closes it:

1. **It is already on file.** An open intent or a story covers the same
   cause. Add what is new there (a Problem bullet, a Decisions line),
   bump the intent's `sightings` and `updated`, and work it from that
   page. A second page for one cause splits the evidence.
2. **Fix it.** Anything that closes the finding and can be checked now:
   code with a test named for the finding, a script or build target, a
   runbook rule, a corrected story, spec or ADR. The measure is
   "finishable and checkable in this session", not a line count. Check
   it the way the change allows (a test, a dry run, a re-read against
   the source) and say which check ran.
3. **Find the cause, then fix it.** When the finding is a symptom,
   investigate before judging its size: read the code, run the
   read-only query, split the measurement. Most findings shrink to a
   fix once the cause has a name.
4. **Prepare it up to the approval.** When closing it takes the
   operator's go (a write to production data, a destructive or
   irreversible step, a change the story's Decisions mark as
   ADR-gated), do everything short of that step. Write the exact
   command, rehearse it where a rollback is possible, and put the
   command and its rehearsed effect in the response. The pending
   approval is the record. It is not an intent.
5. **Ask the operator.** When what is missing is a decision or a fact
   the operator has, ask once in the response, with a recommendation,
   and continue with everything that does not depend on the answer.
6. **File an intent.** Only for a finding still open after the options
   above, and only with its blocker named (next section).

Reading, searching, read-only queries, tests, dry runs that roll back,
and edits to the repository and the wiki need no approval inside a
retro. Work through ordinary obstacles such as a failing command or an
unclear cause. Leave deliberate blockers alone and report them: an ADR
gate, a file marked not to be touched, access that was withheld.

Record a change where it lives. A corrected assumption is corrected
inline in its story, spec or ADR. A sequencing call or a risk that
shapes what ships next is a Decisions entry in the owning story, with
its falsification path. A detour classified *decision* names where it
is recorded, and one classified *done* is the slice tick.

A slice owns its findings. A finding about the slice in progress is
worked before the slice is ticked, and a ticked slice that a finding
contradicts is fixed in the same session or unticked.

Three endings a retro avoids, because each hands hot work to a cold
session: a list of findings with an intent for each; a list of
decisions for the operator when none of them blocks the rest; a closing
plan of next steps with none of them started.

## Filing an intent

An intent is a cold-start capture: its six sections hold what a later
session cannot recover from the code. File one when the finding is
real, the options above did not close it, and something specific
stands in the way:

- someone who has the answer is not in the session,
- it waits on an outside event, such as data that has not arrived,
- it belongs to an ADR amendment round,
- it needs more than this session can give, after an honest attempt.

Use the template: `status: draft`, `origin: retro`, `sightings: 1`,
the six sections, about fifteen lines, a concrete Falsification path.
Open the Constraints section with `Blocked by:` and the blocker. "It
needs a decision" is not a blocker while the operator is present: ask.

Most retros file nothing, and that is a passing retro. A second intent
from one retro is a reason to check that it is not the first one's
cause seen from another side. When an open intent's fix turns out to be
within reach, make the fix and archive the intent with `fixed_by`
naming what proves it.

## The retro note

One note per day at `projects/<scope>/notes/retro-YYYY-MM-DD.md`, no
`kind` field, `updated` taken from `date -u +%Y-%m-%dT%H:%M:%SZ`. Each
invocation appends a section headed by the UTC time and a label, with
only the lines that have content:

```markdown
## 14:30Z — mid-session, resolver

- Fixed: <one line each, with the check that ran>
- Pending approval: <one line each>
- Asked: <one line each>
- Decisions: [[story-<slug>]] § Decisions, sequencing of the engine publish
- Intents: [[intent-<other>]] sightings → 2; [[intent-<slug>]] filed, blocked by <what>
- Detours: <one line each, classified>
```

Ten lines or fewer, pointers only. The substance lives in the code,
the stories and the intents. The note is the freshness signal the
handoff and tag gates read, so its clock must move every time.

## What the operator reads

Write the response for someone who has not seen the tool calls. Lead
with the outcome, in this order, leaving out what is empty:

1. **Fixed**: what changed and the check that ran.
2. **Needs your go**: the exact command and its rehearsed effect.
3. **Needs your answer**: the question and the recommendation.
4. **Filed**: each intent, its blocker, and what was tried first.

Then the three answers, each with its location and what became of it,
and one line naming what the session is re-anchored on
(`story-<slug>`, slice N).

## What a retro leaves to other steps

- **Stories.** A finding that needs a story's shape stays an intent
  until `/triage` promotes it, on a second sighting, a confirmed
  falsification, or the operator's call. A story written at filing
  grows the backlog by ceremony.
- **The primer.** It is written once, at `/handoff`, from the corrected
  state. A retro that edits it carries over the blind spots it was run
  to surface.
- **The plan.** It carries only its Story Index; a session log there is
  the retro note by another name.
- **Postmortems.** Wiki artifacts store project state. How the session
  went is not project state.
