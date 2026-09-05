---
name: handoff
description: This skill should be used to close a session so the next one starts cold from corrected truth. Operator-invoked, gated on a retro note newer than the scope's last edit. Rewrites the primer within its budget first, then runs the status sweep (fully-resolved stories proposed for archiving, flipped only on approval) and reconciles every plan's Story Index — Focus, Next, Open, Read order, about 300 words, nothing another surface derives — confirms the index synced, and prints the one line the next session starts with. Use when the user says "$handoff", "hand off", "close the session", "wrap up the session", "prep the primer", "get the primer ready", "cold session prep", or "what does the next session start with".
metadata:
  version: "0.21.0"
---

# Handoff — Close the Session from Corrected Truth

## Why this exists

The primer is the first thing a cold session reads, and the session
that writes it is the one with the blind spots. So the primer is
written once, at the close, after a retro has surfaced what the
session did not claim — and the write is gated: `retro-before-primer`
denies it until a retro note postdates the scope's last edit. The
handoff is the operator's ceremony, never the agent's; the retro is
the grooming step that precedes it.

## Prerequisites

- `WIKI_SCOPE: <scope>` declared in the project instructions. If
  missing, suggest `$wiki`.
- A retro note under `projects/<scope>/notes/retro-YYYY-MM-DD.md` whose
  `updated` is at or after the newest page under the scope's `plan/`,
  `spec/`, `adr/`, and `intent/` folders. Otherwise stop and run
  `$retro` first.
- The scope's primer at `projects/<scope>/primer.md`.

## The protocol

### Step 1 — Gate check

Read the newest retro note's `updated` and the newest `updated` under
the four working folders. If the retro is older, stop: `$retro`, then
back here. The pretool gate enforces this deterministically; checking
first avoids a denied write mid-ceremony.

### Step 2 — Primer rewrite

Write the primer first — the gate compares the retro note against the scope's newest page, and the sweep and reconcile below move story clocks past it. The primer's reader is an agent: `prime` inlines it into the next
session's context. Write for that reader. Activate the `signal-dense`
register (`$signal-dense`) before drafting, and read
`projects/<scope>/glossary.md` first — every term the primer
uses is a canonical handle from there, typed the way the glossary
types it, never a synonym or a narrative paraphrase. Direct
predicates, no hedging, no register shifts.

Four sections, about 300 words, `updated` from the clock:

- **Focus** — three lines: what the scope is doing now and why.
- **Next** — the top three items, drawn from the Story Index and the
  draft intents ordered by `sightings`. A slice named where one is in
  progress.
- **Open** — pointers to intents only. A question without an intent is
  filed as one first.
- **Read order** — three links.

The rule: nothing in the primer that a query or another surface
derives. Invariants live in the project instructions; versions and
release state in the changelog and tags; counts and active ADRs come
from `prime`. Write it through the harness's file tool or with a
literal vault path, so the gate and the resync both see the write.

### Step 3 — Status sweep

Slices tick during a session; nothing closes a story. List every story
whose slices are all resolved — ticked, or declined with recorded
rationale — and whose `status` is still `active` or `draft`. For each,
name any outstanding verification debt from its Decisions or its
intents. Propose the set. Flip `status: archived` **only on the
operator's approval**, with `updated` from the clock
(`date -u +%Y-%m-%dT%H:%M:%SZ`). The operator decides whether debt
blocks closure. A scope that skips this buries live work under
finished work.

### Step 4 — Story Index reconcile

For each plan under the scope, the Story Index rows match story
frontmatter: state, category, archived stories marked as such, and a
row for every story promoted from an intent this session. The plan's
`updated` moves only if a row changed.

### Step 5 — Confirm the sync

`kmd config`: the `synced` line advanced past the primer write. If
not, `kmd validate`, fix findings, `kmd sync`.

### Step 6 — The next line

One line, last: `Next session starts with: story-<slug> slice N` — or
the top intent when nothing is in progress.

## Output shape

Visible response: the sweep proposal and its outcome, the Story Index
changes, the primer's word count, the sync confirmation, and the next
line. No separate report.

## Anti-patterns

- **Handoff without a retro.** The gate blocks it; a handoff that
  works around the gate inherits the session's blind spots.
- **Sweep without approval.** Archiving is the operator's call; the
  agent proposes.
- **Primer as log.** Session narrative, restated invariants, version
  numbers, and work-item lists that the Story Index already holds are
  the rot the budget exists to prevent.
- **Primer in prose register.** Synonyms, paraphrase, and hedges dilute
  the signal an agent reads; the canonical-dense register and
  the glossary's handles are the primer's language.
- **Open questions without intents.** The primer points; it does not
  carry.
- **Writes the resync cannot see.** A primer written through a shell
  variable path bypasses both the gate and the posttool sync.
