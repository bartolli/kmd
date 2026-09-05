---
name: wiki-sdd
description: The wiki-sdd plugin is installed but disabled. Use when the user asks about the agent wiki, spec-driven development, `$wiki`, `$grill-with-docs`, `$to-prd`, `$triage`, `$to-issues`, `$tdd`, `$retro`, or `$to-triggers` — tell them how to re-enable it.
---

# wiki-sdd is installed but inactive

This session has the `wiki-sdd` plugin discovered but disabled, so its skills, gate hooks, and the `wiki` MCP server are not contributing.

To turn it on:

```
/plugin enable wiki-sdd
/plugin reload
```

Or from a shell: `cortex plugin enable wiki-sdd`, then start a new session.

Once active it contributes nine skills (`wiki`, `grill-with-docs`, `to-prd`, `triage`, `to-issues`, `tdd`, `retro`, `to-triggers`, `signal-dense`), the `kmd hook` gate engine, and the `wiki` MCP server (`prime`, `search`).
