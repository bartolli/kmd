-- llm-wiki Postgres schema. Blueprint v2 §9.
-- Apply once to a fresh database:
--   createdb llm_wiki
--   psql $WIKI_DB < schema.sql
--
-- PG is a derived, disposable projection of the vault. If deleted, it is
-- rebuilt entirely from markdown files via the sync package.
-- One-way: vault → PG. Never the reverse.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE pages (
    id           SERIAL PRIMARY KEY,
    path         TEXT UNIQUE NOT NULL,           -- projects/ontology/spec/spec-x.md
    title        TEXT NOT NULL,
    kind         TEXT NOT NULL,                  -- project|spec|adr|plan|story|ops|topic|article|src|note
    scope        TEXT,                           -- project scope, NULL for research/notes
    topic        TEXT,                           -- research topic, NULL for projects/notes
    status       TEXT NOT NULL DEFAULT 'draft',
    summary      TEXT,
    tags         TEXT[],
    updated      DATE,
    body         TEXT,
    content_hash TEXT,
    meta         JSONB,                          -- non-indexed frontmatter (e.g., triage_state, category, blocked_by, parent for kind=story)
    search_vec   TSVECTOR GENERATED ALWAYS AS (
                   to_tsvector('english',
                     coalesce(title, '') || ' ' ||
                     coalesce(summary, '') || ' ' ||
                     coalesce(body, ''))
                 ) STORED,
    embedding    VECTOR(1536)                    -- NULL until Phase 4
);

CREATE INDEX pages_fts ON pages USING GIN(search_vec);
CREATE INDEX pages_scope_kind ON pages(scope, kind, status);
CREATE INDEX pages_topic_kind ON pages(topic, kind, status);

-- Deferred to Phase 4. ivfflat on empty data is degenerate; create once
-- embeddings are populated, REINDEX as data grows.
-- CREATE INDEX pages_embedding ON pages USING ivfflat(embedding vector_cosine_ops);

-- Wikilinks. No FK on source_path so a page deletion + relinking flow stays
-- driven by the sync (DELETE links WHERE source_path before reinsert; orphan
-- cleanup deletes pages and then their links by source_path).
CREATE TABLE links (
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    link_text   TEXT,
    PRIMARY KEY (source_path, target_path)
);

CREATE INDEX links_source ON links(source_path);
CREATE INDEX links_target ON links(target_path);

CREATE TABLE events (
    id        SERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ DEFAULT now(),
    scope     TEXT,
    operation TEXT NOT NULL,                     -- ingest | edit | sync
    path      TEXT,
    note      TEXT
);

CREATE INDEX events_scope_ts ON events(scope, ts DESC);
