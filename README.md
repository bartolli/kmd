# llm-wiki-infra

Workspace for the llm-wiki infrastructure: Postgres sync + the `wiki-mcp` stdio server.
The vault (markdown content) lives at `../vault/` as a separate git repo.
The system-wide blueprint lives at `../README.md`.

## Prerequisites

- Node.js 22+ (use `nvm use` to pick up `.nvmrc`)
- pnpm 10+ (`corepack enable pnpm`)
- PostgreSQL 16 with the `pgvector` extension

## Setup

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
```

## Environment

```bash
# ~/.zshrc (or direnv / 1Password)
export WIKI_VAULT="$HOME/llm-wiki/vault"
export WIKI_DB="postgresql://localhost/llm_wiki"
```

## Packages

Not yet scaffolded. See `CLAUDE.md` for the planned monorepo shape and the
blueprint (`../README.md` §10) for the phase order driving when each
package gets built.
