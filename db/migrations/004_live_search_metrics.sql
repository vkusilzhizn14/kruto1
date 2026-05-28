-- Per-search performance metrics.
--
-- Each user-facing find-seed call writes one row here regardless of whether
-- it was answered from `query_memo`, `seed_cache` or a live worker spawn.
-- The bot's `/stats` and `/stats_compare` commands aggregate from this
-- table so the operator can see cache hit rate, live-search durations and
-- the seeds-per-second trend over time.
--
-- This table is intentionally separate from `search_history` (which
-- captures user-visible search activity tied to `users.id` and credit
-- debits) and from `query_demand` (which is keyed by canonical query
-- hash and is a moving aggregate). `live_search_metrics` is a flat,
-- append-only event stream optimised for time-windowed rollups.
--
-- Storage budget: ~120 bytes/row × ~10k searches/month → ~1.2 MB/month.
-- Cleanup is left to a future migration once growth becomes a concern.

BEGIN;

CREATE TABLE IF NOT EXISTS live_search_metrics (
    id              BIGSERIAL    PRIMARY KEY,
    /* `user_id` can be NULL for background jobs (explorer / backfill). */
    user_id         BIGINT       NULL,
    /* 16-char prefix of the canonical query hash for grouping. */
    query_hash      TEXT         NOT NULL,
    /* Where the answer came from. NULL means the request did not produce
     * an outcome (e.g. cancelled while queued). */
    source          TEXT         NOT NULL
        CHECK (source IN ('memo', 'cache', 'live', 'not_found', 'cancelled')),
    elapsed_ms      INTEGER      NOT NULL DEFAULT 0,
    seeds_tested    BIGINT       NOT NULL DEFAULT 0,
    found           BOOLEAN      NOT NULL DEFAULT FALSE,
    radius          INTEGER      NOT NULL,
    mc_version      TEXT         NOT NULL,
    /* True if the request originated from a background job (explorer,
     * backfill, curated warmer). Lets us filter user-facing stats from
     * the maintenance traffic. */
    is_background   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_search_metrics_created_idx
    ON live_search_metrics (created_at DESC);

CREATE INDEX IF NOT EXISTS live_search_metrics_source_created_idx
    ON live_search_metrics (source, created_at DESC);

CREATE INDEX IF NOT EXISTS live_search_metrics_user_created_idx
    ON live_search_metrics (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- Track when a seed_cache row last had its full bitmask refreshed by
-- the enrichment binary. Distinct from `added_at` so we can tell apart
-- "row was created at X" from "row was enriched at Y" — which the
-- backfill loop relies on. NULL means never enriched.
ALTER TABLE seed_cache
    ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS seed_cache_enriched_at_idx
    ON seed_cache(enriched_at DESC NULLS LAST);

COMMIT;
