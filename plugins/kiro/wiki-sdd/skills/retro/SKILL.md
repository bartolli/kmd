---
name: retro
description: Formal end-of-session retrospective gate that runs BEFORE authoring or resyncing the wiki primer. Asks exactly two questions — 'What are you least confident about right now?' and 'What's the biggest thing we're missing about the situation right now? What don't I realize?' — then converts every answer into wiki artifacts (story scope extensions, dated plan retro notes, needs-triage stories, primer Open Questions) so the next cold session starts from corrected truth, never chat-only confessions. Use when the user says "/retro", "run the retro", "retro protocol", "session retro", "retro before we close", "prep the primer", "get the primer ready", "cold session prep", "what are we least confident about", "what are we missing", "what don't you realize", or before any primer rewrite at a session boundary.
metadata:
  version: "0.10.0"
---

# Retro — Two Questions Before the Primer

## Why this exists

A session ends with a primer rewrite so the next cold session starts
from truth. The primer author is the same model that did the work —
the failure mode is inheriting the session's blind spots straight into
the "current truth" document. The retro forces a perspective shift
BEFORE authoring: interrogate the session's confidence, convert what
surfaces into artifacts, then write the primer from the corrected
state.

Verification gates check what you claimed. The retro asks what you did
not claim. Precedent: a session's retro surfaced that a
just-shipped containment check was looser than its intent and that a
fail-closed gate needed to cover a second edge kind — both became
story scope extensions, one became a shipped fix. No gate would have
caught either, because no claim covered them.

## Prerequisites

- `WIKI_SCOPE: <scope>` declared in the project instructions. If
  missing, suggest `/wiki`.
- An active plan for the scope (dated retro notes land there). Without
  one, answers route to the primer's Open Questions only.

## When it runs

- MANDATORY before authoring or resyncing the primer at a session
  boundary.
- Worth running at any milestone even mid-session: a release cut, a
  fix batch drained, a plan phase flip.

## The protocol

### Step 1 — Answer the two questions

In order, in the visible response:

1. **What are you least confident about right now?**
2. **What's the biggest thing we're missing about the situation right
   now? What don't I realize?**

Answering rules:

- Answers are about the WORK, not the worker. Name code, artifacts,
  and measurements — never feelings, apologies, or process narrative.
- Every answer carries a location (file, story, number) and a
  falsification path: what a future session runs or reads to confirm
  or kill the concern.
- Question 2 demands the perspective shift: re-read the session's own
  claims as a skeptic. What blind spot did every gate share? What
  would an adversarial reviewer probe first? What state does the
  session assume persists that nothing actually verifies?
- Banned: performative humility ("mistakes may have been made"),
  vacuous confidence ("everything is verified"), and re-announcing
  already-filed open stories as discoveries — reference them instead.
- "Nothing" is not an acceptable answer to either question. There is
  always a least-confident item; if all concerns feel small, rank them
  and name the top one.

### Step 2 — Convert answers to artifacts

Nothing stays only in chat. Route each answer by shape:

| Answer shape | Artifact |
|---|---|
| Unverified claim about landed work | "Not verified" in the session report + verification-debt note in the owning story or plan |
| Suspected gap or unprobed surface | needs-triage story per the scope's findings protocol |
| Invalidated or shaky assumption | Correct the story/ADR/plan where the assumption lives; scope extension if acceptance changes |
| Risk that shapes sequencing | Dated "Session-retro note" in the active plan (release-vs-more-work calls get recorded this way) |
| Residual uncertainty worth carrying | Primer Open Questions entry |

### Step 3 — Then, and only then, the primer

Author the primer update with the retro's residue incorporated. The
primer must cold-start: a session with zero conversational context
recovers the what, the why, and the open risks. Where Step 2 produced
artifacts, the primer references them rather than restating.

## Output shape

Visible response: the two answers (each with location and
falsification path), then the artifact list (file -> what changed).
No separate report document — the artifacts are the output.

## Anti-patterns

- Running the retro AFTER the primer is written: the primer inherits
  exactly the blind spots the retro exists to catch.
- Confession register: wiki artifacts store project state, not
  behavioral postmortems. The retro outputs corrections and open
  questions, never narrative about the agent.
- Artifact-free retro: answers with zero Step 2 conversions mean the
  answers were vacuous or the conversion was skipped. Both fail the
  protocol.
