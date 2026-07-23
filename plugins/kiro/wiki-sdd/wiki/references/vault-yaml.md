# vault.yaml — schema and structure scaffold for new-vault bootstrap

The vault's controlled vocabulary and served pedagogy, at the vault
root. Authority is the `kmd` tooling — when this reference and
`kmd validate` disagree, the tool wins. Loading is fail-loud: an
invalid vault.yaml stops the MCP server from starting and blocks
`kmd sync` / `kmd validate` — a new vault with a broken vault.yaml has
NO working tooling, so get this file right first.

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `scopes` | map: scope name → entry | yes | key = directory name under `projects/`; `prime(scope)` resolves here |
| `scopes.*.status` | string | yes | free string at schema level; keep within `statuses` by convention |
| `scopes.*.repo` | string | no | consumer repo path/URL, informational |
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

## Minimal starter (all required fields, one scope)

```yaml
scopes:
  {{scope}}:
    status: active

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
`kmd validate` checks pages and custom-kind templates, NOT built-in
template presence — the gap only surfaces when an agent first fetches
`wiki://template/...`. Scaffold the structure now, not lazily.

1. Copy the bundled template set verbatim into the vault:

   ```sh
   mkdir -p <vault>/templates
   cp <skill-root>/assets/vault-templates/*.md <vault>/templates/
   ```

   `<skill-root>` is the `wiki/` directory at the power root.
   Filenames are the server's contract — never rename. Expected set
   (11 files): `project-index.md`, `project-primer.md`,
   `project-spec.md`, `project-adr.md`, `project-plan.md`,
   `project-ops.md`, `project-story.md`, `research-index.md`,
   `research-article.md`, `research-src.md`, `note.md`.

2. Create the domain dirs — `prime(scope)` resolves
   `projects/{scope}/index.md` and `primer.md`; search indexes all
   three:

   ```sh
   mkdir -p <vault>/projects <vault>/research <vault>/notes
   ```

The `{{placeholder}}` tokens inside the templates are for the
authoring agent to fill when stamping a page — copy them as-is; a
bootstrap that "renders" them breaks every future page.

## After scaffolding

1. `kmd validate` — confirms `vault.yaml` parses and the (empty)
   vault is consistent.
2. Register/start the wiki MCP server pointing at the vault root;
   verify `prime({{scope}})` answers and `wiki://templates` lists all
   11 entries.
3. Continue the standard `wiki` bootstrap (scope, tracker, project
   instructions template).
