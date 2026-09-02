# vault.yaml reference

`vault.yaml` at the vault root is the controlled vocabulary and the served pedagogy for one vault. Loading is fail-loud: an invalid file stops the MCP server from starting and blocks `kmd sync` and `kmd validate`. Unknown keys are rejected, so a typo'd field never silently does nothing.

The schema lives in one module shared by sync, validate, the MCP server, and `kmd init`. `kmd sync` keeps `vault.schema.json` at the vault root matched to the running engine, and a yaml-language-server modeline on line 1 gives any modern IDE live validation and field docs with no extension setup.

A complete annotated example: [`vault.yaml.example`](../vault.yaml.example).

## Bring an existing vault to the starter

A vault falls behind the engine when a release adds a kind or a template. `kmd init --upgrade [<vault-root>]` reports the additive delta against the starter — kinds, statuses, methodologies, template files, domain dirs the vault lacks — and exits 1 when behind, 0 when current. A template you edited prints as `differs (kept)` and never counts. `--apply` writes the delta and exits 0: it appends to `vault.yaml` in place (comments and the modeline survive), writes only missing template files, creates missing domain dirs, and never touches `scopes`, `tags`, triggers, or an edited template. The vault resolves like `validate` and `sync`: positional, then project tier, then `$WIKI_VAULT`, then the global default.

The session-start orientation names a vault behind the starter, and a missing starter template's `template file missing` error ends with `run kmd init --upgrade`.

## Fields

| Field | Type | Required | Enforced by |
|---|---|---|---|
| `scopes` | map of scope name → entry | yes | schema; `prime(scope)` resolves against it |
| `scopes.*.status` | string | yes | schema (free string; keep within `statuses` by convention) |
| `scopes.*.repo` | string | no | `kmd hook`: resolves the active scope from the session's working directory |
| `scopes.*.methodology` | string | no | schema: must appear in `methodologies` |
| `kinds` | (string \| `{name, signal, where}`)[] | yes | `kmd validate`: page `kind` must be listed; object form adds a kind-selector row |
| `statuses` | string[] | yes | `kmd validate`: page `status` must be listed |
| `methodologies` | string[] | yes | `kmd validate` (pages) + schema (scope entries) |
| `tags.canonical` | string[] | yes | membership check currently deferred; `prime` surfaces `top_tags` |
| `tags.aliases` | map alias → canonical | yes | `kmd validate` warns when a page uses an alias |
| `authoring_rules` | multiline string | no | replaces `wiki://authoring` § Authoring rules (escape hatch) |
| `authoring_rules_extra` | multiline string | no | appended after the served § Authoring rules |
| `sync_protocol` | multiline string | no | replaces `wiki://authoring` § Resync protocol (escape hatch) |
| `sync_protocol_extra` | multiline string | no | appended after the served § Resync protocol |
| `builtin_hooks` | map id → `{reason?, text?}` | no | operator prose for the fixed-function hooks (`resync`, `handoff-gate`, `orient`, `reorient`) |
| `triggers` | map scope → trigger list | no | full-replace of the built-in + plugin trigger base for that scope (escape hatch) |
| `triggers_extra` | map scope → trigger list | no | appended per scope; the reserved `_all` key applies to every session |

The starter `kmd init` writes, with two scopes and a tag filled in:

```yaml
scopes:
  my-app:
    methodology: sdd        # optional: any value from `methodologies`
    status: active
    repo: ~/Projects/my-app # lets hooks resolve the scope from the working directory
  research-notes:
    status: active

kinds: [project, spec, adr, plan, story, ops, topic, article, src, note, artifact, prompt, intent]
statuses: [draft, active, superseded, archived]
methodologies: [sdd, tdd, hybrid]

tags:
  canonical: [auth, api, sync]
  aliases:
    authentication: auth    # normalize on write; warn on validate
```

## Served pedagogy

The MCP resource `wiki://authoring` is how agents learn to write in your vault. It opens with the vault root, then a kind-selector table, the controlled vocabulary, authoring rules, and the resync protocol. It ships with strong defaults and is assembled fresh from `vault.yaml` on every read. Edit the config and the next agent session works under the new rules. No rebuild, no restart.

### Add vault-specific rules, keep every default

The `_extra` fields append to the served sections. You keep the full built-in rulebook, and future default improvements keep flowing to your vault:

```yaml
authoring_rules_extra: |
  - **Diagrams live in `assets/`** as `.excalidraw.md`; embed with `![[...]]`, don't inline SVG.
  - **Meeting notes are one file per meeting**: `notes/mtg-{date}-{topic}.md`.

sync_protocol_extra: |
  Session-closing primer resyncs run /retro first: convert every finding
  into wiki artifacts, then author the primer from the corrected state.
```

The served result: § Authoring rules is the complete default set with your rules at the end; § Resync protocol gains your addition after the default edit-validate-sync loop.

### Teach the agent a custom kind

A `kinds` entry in object form adds a row to the served kind selector. `signal` says when to pick the kind; `where` is the path pattern to follow:

```yaml
kinds:
  - spec
  - adr
  - note
  - name: experiment
    signal: Hypothesis, setup, and outcome of a training run
    where: "`projects/{scope}/lab/exp-{slug}.md`"
```

Served kind selector:

```markdown
| Signal | Kind | Where |
|---|---|---|
| How a system works (state of world, not decision) | **spec** | `projects/{scope}/spec/spec-{slug}.md` |
| Decision between alternatives, commits direction | **adr** | `projects/{scope}/adr/adr-{slug}.md` |
| Low-ceremony capture, sort later | **note** | `notes/{slug}.md` |
| Hypothesis, setup, and outcome of a training run | **experiment** | `projects/{scope}/lab/exp-{slug}.md` |
```

`kmd validate` accepts `kind: experiment` on pages. Plain-string entries use the built-in pedagogy; the object form also lets you reword a built-in kind's row.

Kinds with built-in pedagogy: `project`, `spec`, `adr`, `plan`, `story`, `ops`, `topic`, `article`, `src`, `note`, `artifact`, `prompt`, `intent`. The starter `kmd init` writes lists all of them.

The template comes with the kind: drop `templates/experiment.md` in the vault and it is served at `wiki://template/experiment`, listed in `wiki://templates` with the kind's `signal` as its description, the same fresh-from-disk serving as the built-ins. A declared custom kind without its template file is a `kmd validate` warning, so the gap never goes unnoticed.

Custom-kind pages get a soft universal floor instead of the built-ins' strict one: missing `title`, `summary`, or `updated` warns but never blocks. Those three feed the index (`title` and `summary` feed search, `updated` feeds `prime` ordering), so the nudge keeps pages retrievable while everything beyond the floor stays the kind's own business.

### Bring your own methodology

The `methodologies` list is the single authority for page frontmatter and scope entries. There is no hard-coded set:

```yaml
scopes:
  care-ops:
    methodology: pdca-raci   # legal because the list declares it
    status: active

methodologies: [sdd, tdd, hybrid, pdca-raci]
```

A scope methodology missing from the list fails the whole file at load, before any index write.

### Replace wholesale (escape hatch)

`authoring_rules` and `sync_protocol` (without `_extra`) replace the served section entirely. Every default rule not restated is gone. Reach for this only when your vault genuinely runs a different rulebook.

Custom `statuses` behave similarly on the serving side: only the canonical `draft → active → superseded → archived` set is presented as a one-directional lifecycle. Any other list is served as a plain enumeration, and the ordering pedagogy is yours to supply via `authoring_rules_extra`.

## Triggers

Trigger declarations (`triggers_extra`, `triggers`, the `_all` key, matching semantics, and `when` predicates) are covered in the [README § Hooks](../README.md#hooks). The trigger schema is part of `vault.yaml` and validated on every load like everything else.
