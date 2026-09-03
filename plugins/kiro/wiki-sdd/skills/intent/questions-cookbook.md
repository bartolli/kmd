# Grilling Questions Cookbook

Common questions per stage with recommended answers. Adapt to the project — don't read mechanically.

## Stage A — Identity (greenfield)

| Question | Recommended posture |
|---|---|
| What does this project deliver, in one phrase? | Push for a noun phrase, not a verb phrase. "Operations system for X" beats "manages operations for X." |
| Who uses it? | Surface the primary user (one role); secondary users come later. |
| What problem are you solving? | One sentence. If the answer takes a paragraph, the problem isn't clear yet. |
| What's the closest existing thing? | Helps locate the project against known patterns; reveals what the user is *not* building. |
| What's out of scope on day one? | A "not building" list shrinks the design space fast. |

## Stage B — Methodology

| Question | Recommended answer rule |
|---|---|
| `sdd`, `tdd`, or `hybrid`? | Default `hybrid` for app-layer work (most projects). `sdd` when the surface is contract-first (APIs, protocols, MCP servers, library boundaries). `tdd` when behavior is the dominant signal and specs would lag. State your reasoning. |
| What's the smallest thing you can ship? | A "hello world" tracer — the thinnest vertical that exercises every layer. Land this before designing the second slice. |

## Stage C — Vocabulary (lazy → glossary.md)

When the user introduces a term, ask:

- **Is this term shared with the user?** ("Customer" might mean different things to dev vs. product.)
- **Is there an existing word that competes?** ("cancellation" vs "void" vs "refund" — pick one.)
- **Is this a domain concept or a programming concept?** General programming concepts (timeout, retry, error type) don't belong in `glossary.md`.

When two terms compete, propose a canonical pick with reasoning. Push back if the user picks a vague term.

When a term is overloaded ("account" = `Customer` or `User`?), force the disambiguation: *"You said 'account' — which one? Those are different things."*

## Stage D — Relationships

| Question | Posture |
|---|---|
| How does X relate to Y? | Force cardinality: 1:1, 1:N, M:N. |
| Can X exist without Y? | Surfaces lifecycle dependencies. |
| Who creates X? Who deletes X? | Reveals the system boundary that owns each entity. |
| When does X transition state? | Implies a state machine; worth surfacing if the project has lifecycle objects. |

## Stage E — ADRs (lazy)

Before offering an ADR, run Matt's three-test:

1. Hard to reverse?
2. Surprising without context?
3. Real trade-off (genuine alternatives)?

If yes, ask: *"Should I capture this as an ADR? It looks hard to reverse, future readers will wonder why, and there were real alternatives — those are the three reasons to write one."*

Common ADR territories:

- **Storage backend** — embedded vs managed vs warehouse
- **Transport** — HTTP vs gRPC vs stdio (for MCP servers)
- **State management** — event-sourced vs mutable, optimistic vs pessimistic
- **Migration strategy** — additive only vs destructive
- **Testing strategy** — unit-heavy vs integration-heavy, mocks vs real services

## Stage F — Contradiction surfacing (brownfield)

When user description and code/spec disagree:

> "Your code does X, but you just said Y. Which is right?"

Don't assume which side wins. Ask. Then update the wrong side — usually the spec lags reality, but sometimes the code is wrong and the spec is the goal.

## Stage G — Wrap-up cues

End the grill when:

- The user says "I think we're good" — verify the artifacts list (`index.md`, `primer.md`, `glossary.md` if any terms resolved, ADRs if any decisions surfaced).
- You can't think of another concrete question — that's a signal you've exhausted productive grilling, not a hint to invent filler.
- Three consecutive questions get short, generic answers — the user is fatigued; stop and let work resume.

State termination explicitly. Don't drift.
