# vault.yaml — schema and structure scaffold for new-vault bootstrap

The vault's controlled vocabulary and served pedagogy, at the vault
root. Authority is the `kmd` tooling — when this reference and
`kmd validate` disagree, the tool wins. Loading is fail-loud: an
invalid vault.yaml stops the MCP server from starting and blocks
`kmd sync` / `kmd validate` — a new vault with a broken vault.yaml has
NO working tooling, so get this file right first. Unknown keys are
rejected loud at every level — a typo'd field never silently does
nothing. The engine emits this schema as `vault.schema.json`
(draft-07 JSON Schema, refreshed by `kmd sync`); the
yaml-language-server modeline on `vault.yaml` line 1 binds any modern
IDE to it for live validation and hover docs.

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `scopes` | map: scope name → entry | yes | key = directory name under `projects/`; `prime(scope)` resolves here |
| `scopes.*.status` | string | yes | free string at schema level; keep within `statuses` by convention |
| `scopes.*.repo` | string | no | consumer repo path — load-bearing for `kmd hook`: the engine resolves the active scope by matching the session's working directory against it (longest declared path wins, `~` expands) |
| `scopes.*.methodology` | string | no | must appear in `methodologies` below — one list, one authority |
| `kinds` | (string \| `{name, signal, where}`)[] | yes | page `kind` vocabulary; validate-enforced. Object form adds a kind-selector row to `wiki://authoring`: *signal* = when to pick the kind, *where* = its path pattern |
| `statuses` | string[] | yes | page `status` vocabulary; validate-enforced. The canonical set below is served as a one-directional lifecycle; a custom set is served as a plain list |
| `methodologies` | string[] | yes | `methodology` vocabulary for pages and scope entries |
| `tags.canonical` | string[] | yes | approved tags; membership check currently deferred |
| `tags.aliases` | map: alias → canonical | yes | validate warns on alias use; `{}` is valid |
| `authoring_rules_extra` | multiline string | no | appended after the served `wiki://authoring` § Authoring rules — the normal way to add vault-specific rules |
| `sync_protocol_extra` | multiline string | no | appended after the served § Resync protocol |
| `authoring_rules` | multiline string | no | replaces § Authoring rules entirely — escape hatch; every default rule not restated is gone |
| `sync_protocol` | multiline string | no | replaces § Resync protocol entirely — same caveat |
| `triggers_extra` | map: scope → trigger list | no | appended per scope after the engine defaults; the reserved `_all` key fires in every session regardless of scope |
| `triggers` | map: scope → trigger list | no | full-replace of the trigger base for that scope — escape hatch, same semantics as the pedagogy fields |

Kinds with built-in authoring pedagogy (kind-selector rows in
`wiki://authoring`): `project`, `spec`, `adr`, `plan`, `story`, `ops`,
`topic`, `article`, `src`, `note`, `artifact`, `prompt`. A custom kind
gets its row via the object form; prefer the built-ins for a new vault.

## Custom kinds: template co-authoring

A custom kind declared in object form is also expected to have a
template at `templates/{name}.md` — served at `wiki://template/{name}`
with the kind's `signal` as its description; `kmd validate` warns while
the file is missing. When the user declares a custom kind, offer to
co-author the template immediately (the intent is in the conversation
right then):

1. Start from the universal frontmatter — the fields the index serves:
   `title`, `kind` (prefilled with the custom kind), `status`,
   `summary`, `tags`, `created`, `updated`. Missing `title`/`summary`/
   `updated` on custom pages draws a validate warning (soft floor,
   never blocks); `tags` is required on all content pages.
2. Derive the body scaffold from the kind's `signal` — section
   headings that answer it (e.g. signal "Hypothesis, setup, and
   outcome of a lab run" → `## Hypothesis`, `## Setup`, `## Outcome`).
3. Stamp the first real page from the template and run `kmd validate`
   to close the loop — validate checks pages, not template files.

## Harness gate triggers

`triggers_extra` / `triggers` declare the vault-owned rules that
`kmd hook` evaluates at harness events — reminders injected when a
prompt touches them, gates that warn on or deny a tool call. Trigger
validation is part of vault.yaml loading and fail-loud: one invalid
trigger breaks the whole file, and with it every tool.

Each trigger entry:

| Field | Applies to | Notes |
|---|---|---|
| `id` | all | unique; duplicate ids keep the first occurrence |
| `on` | all | `prompt` or `pretool` |
| `enforce` | all | `inject` (context line) \| `warn` (stderr) \| `block` (deny with reason) |
| `keywords` | prompt | word-boundary, porter-stemmed match (`releasing` matches `release`, `prerelease` does not); prompt triggers need `keywords` or `intent` |
| `intent` | prompt | regexes over the raw prompt, case-insensitive — the escape hatch for phrasings stemming can't reach |
| `tool` | pretool | exact tool name; pretool triggers need `tool`, `args_match`, or `files`; matchers AND-compose |
| `args_match` | pretool | regex over the serialized tool input |
| `files` | pretool | globs against the paths the tool touches, relative to the session's working directory (`**` crosses directories, `*` stays within a segment); invalid on prompt triggers |
| `when` | pretool | precondition — the gate fires only when it is UNMET. One predicate: `{name: newer-than, fresh: [globs], than: [globs]}` — the newest page matching `fresh` must carry frontmatter `updated` at or after the newest matching `than`; when `than` matches nothing the gate passes |
| `text` | inject, warn | required — the line injected or warned |
| `reason` | block | required — the denial the agent reads |
| `dedup` | inject, warn | re-fire policy: `session` (default, once per session), `never` (every match), or `{minutes: N}` (once per bucket within a session); invalid on block triggers — blocks fire on every matching event |

```yaml
triggers_extra:
  _all:                        # reserved: every session, whatever the scope
    - id: skill-notes
      on: prompt
      enforce: inject
      keywords: [scratchpad, jot]
      text: "Skill: /notes captures scratch thoughts into the vault."
  {{scope}}:
    - id: retro-before-tag
      on: pretool
      enforce: block
      tool: Bash
      args_match: "\\bgit tag\\b"
      when:
        name: newer-than
        fresh: ["notes/{{scope}}-retro-*.md"]
        than: ["projects/{{scope}}/ops/release-*.md"]
      reason: "Retro gate: run the retro before tagging."
```

A fresh vault needs no triggers — grow them from observed failures,
like the rest of the vocabulary. The auto validate + sync loop
(`kmd hook posttool`) is fixed-function and needs no vault.yaml
configuration at all; do not invent trigger entries for it. Hook
*wiring* (which harness events invoke `kmd hook`) is plugin/adapter
territory, not vault.yaml.

## Minimal starter (all required fields, one scope)

```yaml
scopes:
  {{scope}}:
    status: active
    repo: {{repo_path}}        # enables kmd hook scope resolution from the session cwd

kinds: [project, spec, adr, plan, story, ops, topic, article, src, note]
statuses: [draft, active, superseded, archived]
methodologies: [sdd, tdd, hybrid]

tags:
  canonical: []
  aliases: {}
```

Grow vocabulary by use, not upfront: add tags when pages need them
(controlled-vocabulary edits need explicit user approval); extend
pedagogy with `_extra` fields when the vault develops its own
conventions; add kinds only as a deliberate vault-blueprint decision
(the built-in set covers the methodology), and if you do, use the
object form so the agent learns when and where to use them.

## Vault structure scaffold

`vault.yaml` alone is not a working vault. The MCP server serves the
11 built-in templates from `templates/` at the vault root — the
URI→filename mapping is fixed in the server, files are re-read on
every `resources/read`, and a missing file errors at read time.

The engine owns the scaffold — never assemble it by hand:

```sh
kmd init <vault-dir>
```

`kmd init` refuses a non-empty target, then writes the starter
`vault.yaml` (empty `scopes`, IDE modeline on line 1),
`vault.schema.json`, the 11 built-in templates into `templates/`,
and the `projects/`, `research/`, `notes/` domain dirs, and prints
the `WIKI_VAULT` value to export. Add the user's
first scope to the generated `vault.yaml` — § Minimal starter above
shows the shape — and run `kmd validate` before continuing.

The `{{placeholder}}` tokens inside the templates are for the
authoring agent to fill when stamping a page — leave them as-is; a
bootstrap that "renders" them breaks every future page.

## After scaffolding

1. `kmd validate` — confirms `vault.yaml` parses and the (empty)
   vault is consistent.
2. Register/start the wiki MCP server pointing at the vault root;
   verify `prime({{scope}})` answers and `wiki://templates` lists all
   11 entries.
3. Continue the standard wiki-skill bootstrap (scope, tracker, project
   instructions template).
