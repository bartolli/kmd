---
title: {{title}}
kind: story
scope:
parent:
status: active
triage_state: needs-triage
category: enhancement
blocked_by: []
tags: []
sources: []
created: "{{date}}"
updated: {{date}}
---

# {{title}}

## User Story

As a {{actor}}, I want {{capability}}, so that {{benefit}}.

## Scenarios

Scenarios are the test specification — each becomes a failing test
before implementation. Write observable outcomes, not implementation
steps.

**Scenario: {{scenario name}}**
- Given {{precondition}}
- When {{action}}
- Then {{expected outcome}}

**Scenario: {{edge case name}}**
- Given {{precondition}}
- When {{action}}
- Then {{expected outcome}}

## Slices

Vertical tracer bullets: each slice ships signature + implementation +
tests + wiring, independently committable. `AFK` = agent works alone;
`HITL` = human in the loop.

- [ ] **Slice 1** — {{description}} · `AFK` · [[spec-{{topic}}]]
- [ ] **Slice 2** — {{description}} · `HITL` · [[adr-{{decision}}]]

## References

- [[spec-{{related-spec}}]]
- [[adr-{{related-adr}}]]
