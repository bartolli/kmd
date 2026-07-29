---
name: to-triggers
description: Turn a plain-language rule into a well-formed vault trigger entry. Interviews intent (remind vs warn vs block), then authors the matching mechanics itself — stemmed keyword choice, anchored regexes, glob semantics, predicate selection — proves fire and near-miss behavior with a dry run, and writes vault.yaml only on explicit approval with kmd validate green after. The human owns the intent; the skill owns the regex. Use when the user says "add a hook", "add a trigger", "add a rule for", "create a gate", "block X until Y", "remind me about X when", "never let X happen before Y", "/to-triggers", or right after a protocol rule failed to fire — the moment a prose rule proves it needs to become a gate.
metadata:
  version: "0.10.0"
---

# To-Triggers — Author Vault Gate Triggers from Intent

Convert a stated rule into a trigger entry in `vault.yaml`. The division of
labor is fixed: the user owns the intent ("never let a tag happen before the
retro"); the agent owns the matching sophistication. A mis-authored trigger
either never fires (silent protocol decay) or fails the `vault.yaml` load
(fail-loud: one invalid trigger takes down every tool). Never hand the user a
regex question they didn't ask for.

## Source of truth

The trigger schema is read at use time, never from memory:

- The `wiki` skill's `references/vault-yaml.md` § Harness gate triggers (ships
  alongside these skills) — field vocabulary and examples.
- The vault's own `vault.schema.json` (vault root) and `kmd validate` — the
  runtime authority. When the reference file is unavailable, these suffice.

## Interview flow — recommend first

Draft a complete trigger from the user's sentence, present it, and ask only
what could not be inferred. Never open the interview with questions the intent
already answers.

1. **Intent class.** Map the sentence:

   | The user wants | Class | Event |
   |---|---|---|
   | a reminder when a topic comes up | `inject` | `prompt` |
   | a nudge alongside a risky tool call | `inject` or `warn` | `pretool` |
   | an action denied until a precondition holds | `block` | `pretool` |

   Only `pretool` can block. A prompt-time rule that sounds like a gate
   ("never tag before the retro") is really a pretool block on the tagging
   command plus, optionally, a prompt-time reminder — propose both, let the
   user drop one.

2. **Matching draft.** Author the mechanics (rules below) with the trigger
   `id` (descriptive kebab-case; duplicate ids keep the first occurrence).

3. **Payload register.** `text` (inject) and `reason` (block) are read by an
   agent mid-session: one ASCII line naming the protocol pointer, no banners.
   A block `reason` tells the denied agent what to do instead, not just why.

4. **Scope.** Propose where it lands: the active scope's `triggers_extra`
   (additive), or `triggers_extra._all` for vault-wide. A full-replace
   `triggers` section only on explicit request — it drops the engine defaults
   and the compiled file source too.

5. **Precondition.** When the rule is state-dependent ("until the retro is
   newer than the release note"), attach `when: newer-than {fresh, than}` —
   the trigger fires when the predicate is FALSE, is suppressed when true,
   and is skipped loudly when unevaluable. The clock is frontmatter
   `updated`; an empty `than` set passes vacuously. Globs select the two
   page sets; each scope names its own retro/release conventions.

## Matching mechanics — the part the user never writes

**Keywords (prompt inject).** The engine matches through a stemmed,
word-boundary FTS5 porter table. Consequences:

- Two or three distinctive keywords beat a long list. Never enumerate word
  forms — `release` already matches "releasing", "released".
- Word-boundary matching kills substring false positives ("prerelease" does
  not match `release`); don't defend against them with regex.
- `intent` regexes are the escape hatch for phrasings stemming cannot reach,
  not the default.

**Pretool matchers.** AND-composed, deterministic:

- `tool` equals the event's tool name.
- `args_match` is an authored, anchored regex over the serialized tool input
  (compound commands included). Draft it against real command shapes — for
  "block force pushes": matches `git push --force origin main` and
  `git push -f`, does not match `echo "force push"`. Write the near-miss
  counterexamples down; they become the dry-run cases.
- `files` globs are cwd-relativized: `**` crosses directories (`**/` may
  match empty), `*` stays within a segment, `?` is one character.

**Noise budget.** Name the cost of a broad draft before accepting it:
inject-class dedup is once per session per trigger, so a broad keyword still
fires in every session; block-class is exempt from dedup and fires on every
matching event. Propose the narrower match first, with the broad one as the
explicit fallback.

## Test before write — the dry-run loop

No draft touches `vault.yaml` untested. Write the candidate entries to a
temp file as a bare YAML list (exactly the entries, not nested under a
scope key) and pipe synthetic events through the engine:

```bash
cat > /tmp/triggers-draft.yaml <<'EOF'
- id: release-protocol-reminder
  on: prompt
  enforce: inject
  keywords: [tagging, releasing]
  text: "Release protocol: ops-publish-kmd is the release chain."
EOF
```

**Synthetic events** — one JSON object on stdin per run:

```bash
# prompt event: {"session_id": "...", "prompt": "...", "cwd": "..."}
printf '%s' '{"session_id":"dry-1","prompt":"thinking about releasing tomorrow","cwd":"/tmp"}' \
  | kmd hook prompt <vault-root> --triggers /tmp/triggers-draft.yaml

# pretool event: {"session_id": "...", "tool_name": "...", "tool_input": {...}, "cwd": "..."}
printf '%s' '{"session_id":"dry-2","tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"cwd":"/tmp"}' \
  | kmd hook pretool <vault-root> --triggers /tmp/triggers-draft.yaml
```

**Reading the results.** An inject match prints the `text` line to stdout; a
block match prints neutral JSON (`{"decision":"deny","reason":…}`); no match
prints nothing. Hook events always exit 0 — the exit code carries no fire
signal, only the output does.

**Fresh `session_id` per case.** Inject dedup keys on the session id: a
reused id silences the second run, which reads exactly like a failed match.
Use a throwaway id per case (`dry-1`, `dry-2`, …); reuse one deliberately
only when the thing under test is the dedup itself. Block-class triggers are
dedup-exempt, so they re-fire on every matching event.

**Fire + near-miss discipline.** Every matcher runs at least one
intended-fire case and one near-miss counterexample, and the user sees both
results. The near-misses were written down while drafting the matcher —
"prerelease" against `keywords: [releasing]` (word boundary holds),
`echo "force push"` against the force-push regex (no match). A matcher
proven only on its fire case is untested.

**Predicate drafts.** A `when: newer-than` candidate is tested against the
real vault filesystem read-only — the vault-root argument points at the real
vault so the globs select real pages. Never fabricate retro or release
fixtures inside a real vault to make a predicate evaluate.

## Write gate

1. Show the exact YAML block and its target key.
2. Write only on explicit approval — `vault.yaml` is a controlled-vocabulary
   surface.
3. Run `kmd validate` after the write. Red means revert before anything else:
   an invalid config fails the load for every tool, not just the new trigger.
