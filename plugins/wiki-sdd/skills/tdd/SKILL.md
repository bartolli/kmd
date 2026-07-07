---
name: tdd
description: Implement a single `ready-for-agent` slice from a wiki user story using disciplined red-green-refactor with vertical tracer bullets. Reads the slice description, the story's Gherkin scenarios (as the test specification), `spec-context.md` (for vocabulary), and the referenced specs/ADRs. Refuses horizontal slicing (write-all-tests-then-all-impl). Ticks the slice checkbox when done. Use when the user says "let's TDD slice X", "implement slice 2 of story Y", "/tdd", "red-green-refactor this", or wants to start vertical-slice implementation on a wiki-tracked story.
---

# TDD — Vertical Tracer-Bullet Test-Driven Development

Take ONE `ready-for-agent` slice from a wiki story and implement it with the red-green-refactor loop. The story's Gherkin scenarios ARE the test specification — translate them directly into integration tests.

## Prerequisites

- `WIKI_SCOPE: <scope>` declared in the project instructions.
- Target slice exists in a story file at `projects/<scope>/plan/<plan-name>/story-N-<slug>.md`.
- The parent story's `triage_state` is `ready-for-agent`. If `needs-info` or `needs-triage`, suggest `/triage` first.

## Philosophy

**Test behavior through public interfaces, not implementation details.** Code can change entirely; tests shouldn't.

- **Good tests** are integration-style: they exercise real code paths through public APIs. They describe *what* the system does, not *how*. They survive refactors.
- **Bad tests** are coupled to implementation: mock internal collaborators, test private methods, query internals directly. Warning sign: test breaks when you refactor but behavior hasn't changed.

A story's **Gherkin scenarios are your test specification**. Each `Scenario` block translates to one integration test. Given/When/Then maps to setup/action/assertion.

## Anti-pattern: Horizontal slicing — REFUSED

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" — treating RED as "write all tests" and GREEN as "write all code."

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
```

Why horizontal produces crap tests:

- Tests written in bulk test *imagined* behavior, not *actual* behavior.
- You end up testing the *shape* of things rather than user-facing behavior.
- Tests become insensitive to real changes.
- You outrun your headlights — committing to test structure before understanding the implementation.

If you find yourself writing test #2 before test #1's implementation passes, **stop**. Finish the green for #1 first.

## Process

### 1. Read the slice context

- Read the story file: User Story, Scenarios, Slices, References.
- Identify the target slice (user names it, or pick the next unchecked slice).
- Read `spec-context.md` for vocabulary — test names, variable names, interface vocabulary should match the project's domain language.
- Read each referenced `[[spec-X]]` and `[[adr-Y]]` for technical constraints.
- Read recent ADRs in the scope's `adr/` for testing strategy decisions (look for `adr-testing-strategy.md` or similar).
- Identify whether prior tests in the codebase establish a pattern (test framework, structure, helpers). Match the existing style.

### 2. Plan the slice (one block of upfront thinking, then loop)

Before writing code:

- [ ] Confirm with user what interface changes the slice requires (if not already obvious from spec).
- [ ] List the **behaviors to test** for THIS slice (not all of the story — only what this slice covers).
- [ ] Identify deep-module opportunities (small interface, deep implementation).
- [ ] Check that scenarios are concrete enough to be tests; if not, return to `/triage`.
- [ ] Get user approval on the test list.

State your plan briefly. Don't burn turns enumerating implementation steps — the loop will reveal them.

### 3. Tracer bullet (first vertical)

Pick the simplest scenario from the slice. Translate it to ONE test:

```
RED:   Write test for scenario 1 → test fails (compilation or assertion)
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet — it proves the path works end-to-end through every layer.

### 4. Incremental loop

For each remaining scenario in this slice:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- **One test at a time.**
- **Only enough code to pass the current test.**
- **Don't anticipate future tests** (that's horizontal-slicing creeping in).
- **Keep tests focused on observable behavior** — through the public interface only.
- **Run all prior tests** after each green to catch regressions.

### 5. Refactor (only after slice is green)

After all scenarios for this slice pass:

- [ ] Extract duplication.
- [ ] Deepen modules — move complexity behind simple interfaces.
- [ ] Apply principles where natural (DRY, SOLID), but don't force them.
- [ ] Consider what new code reveals about existing code.
- [ ] Run tests after each refactor step.

**Never refactor while RED.** Get to GREEN first.

### 6. Tick the slice checkbox

Once the slice is green and refactored:

1. Open the story file.
2. Tick the corresponding `## Slices` checkbox: `- [ ]` → `- [x]`.
3. Bump `updated:` in the story's frontmatter.
4. If ALL slices in the story are now ticked:
   - Note this in the parent plan's Story Index — the story is "done" but its `triage_state` stays as-is until user-promotion.
   - Suggest the user mark `status: archived` on the story when they're satisfied.
5. Sync the wiki:
   ```bash
   kmd sync
   ```

### 7. Done — report

> "Slice <N> of `[[story-N-<slug>]]` is green. <count> tests added. Remaining slices in this story: <list of unchecked>. Next: pick another slice or move to a different story."

## Per-slice checklist

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive an internal refactor
[ ] Code is minimal for the current test
[ ] No speculative features added
[ ] No mocks of internal collaborators
[ ] All prior tests still pass
```

## Mocking guidance

- **Mock external systems at the boundary** — third-party APIs, network calls to services not under test.
- **Don't mock your own internal collaborators** — that's coupling tests to structure.
- **Don't mock the database in integration tests** — use a real test database. Mock-based tests passing while migrations break is a real failure mode (recurring industry incident).
- If the user has an `adr-testing-strategy.md` or similar, follow its guidance.

## Deep modules

A **deep module** has a small interface and a substantial implementation. A **shallow module** has a large interface relative to its implementation (often a thin wrapper).

When refactoring:

- Look for shallow modules to deepen — push complexity behind narrower interfaces.
- Look for opportunities to encapsulate variability — make the surface stable while internals can change.
- Don't deepen prematurely — let the third use-case reveal the right shape.

## Spec/ADR drift

If during implementation you discover the spec is wrong (code reality differs from `spec-{topic}.md`):

- **Update the spec inline** in the same commit as the slice. Don't queue spec corrections in the plan — that creates doc-debt the wiki resync protocol explicitly forbids.
- If the divergence is a hard-to-reverse decision, propose an ADR via `/grill-with-docs`.

## Rules

- **One slice per session.** Don't bundle slices.
- **Tests before code, every time.** No exceptions.
- **One test, then make it green, then next test.** Vertical, not horizontal.
- **Minimum code to pass.** No speculative features.
- **Refactor only when green.**
- **Tick the checkbox when done** — that's the resync protocol's signal that the slice shipped.
- **Sync the wiki** (`kmd sync`) so the index reflects the new slice state.
- **Update spec inline** if reality diverges; don't queue corrections.
- **Quote prose-bearing frontmatter scalars** to avoid breaking the sync walker.
