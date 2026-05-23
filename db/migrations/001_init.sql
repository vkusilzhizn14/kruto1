-- kruto52 — initial schema.
--
-- Layered per Blueprint v3 §4:
--   • users           — Telegram user profile + balance + subscription state
--   • credits_ledger  — append-only debit/credit journal (idempotent)
--   • billing_audit_log — every payment attempt for compliance / reconciliation
--   • search_history  — what each user searched for, when, and the outcome
--   • seed_cache      — precomputed (seed × radius × version) → bitmask of
--                       biomes / structures present, for sub-100ms lookups
--   • query_memo      — sha256(canonical_request) → seeds returned, with
--                       hit counters powering adaptive precompute
--
-- Seeds are stored as int8 (Postgres bigint, range matches Java long).

BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    tg_id           BIGINT      NOT NULL UNIQUE,
    tg_username     TEXT,
    tg_first_name   TEXT,
    tg_language     TEXT,
    balance_credits INTEGER     NOT NULL DEFAULT 0 CHECK (balance_credits >= 0),
    pro_expires_at  TIMESTAMPTZ,
    free_used_today INTEGER     NOT NULL DEFAULT 0,
    free_used_date  DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_tg_id_idx ON users(tg_id);
CREATE INDEX IF NOT EXISTS users_pro_expires_idx ON users(pro_expires_at)
    WHERE pro_expires_at IS NOT NULL;

-- Append-only. delta > 0 = credit added (purchase/refund/bonus); delta < 0 =
-- credit spent (search). idempotency_key forces unique applications across
-- retries.
CREATE TABLE IF NOT EXISTS credits_ledger (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta           INTEGER     NOT NULL,
    reason          TEXT        NOT NULL,
    idempotency_key TEXT        NOT NULL UNIQUE,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credits_ledger_user_idx ON credits_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credits_ledger_reason_idx ON credits_ledger(reason);

-- Every payment event regardless of outcome. method = 'tg_stars' | 'cryptobot'.
CREATE TABLE IF NOT EXISTS billing_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    method          TEXT        NOT NULL,
    pack_id         TEXT        NOT NULL,
    amount_minor    BIGINT      NOT NULL,
    currency        TEXT        NOT NULL,
    provider_ref    TEXT        UNIQUE,
    status          TEXT        NOT NULL,
    raw_payload     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS billing_audit_user_idx ON billing_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_audit_method_status_idx ON billing_audit_log(method, status);

-- Every accepted search request. result_seed NULL => no result delivered.
CREATE TABLE IF NOT EXISTS search_history (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mc_version      TEXT        NOT NULL,
    large_biomes    BOOLEAN     NOT NULL DEFAULT FALSE,
    radius          INTEGER     NOT NULL,
    biome_mask      BIGINT      NOT NULL,
    structure_mask  BIGINT      NOT NULL,
    query_hash      TEXT        NOT NULL,
    source          TEXT        NOT NULL,
    result_seed     BIGINT,
    result_payload  JSONB,
    elapsed_ms      INTEGER,
    seeds_tested    BIGINT,
    debited_credits INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS search_history_user_idx ON search_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS search_history_hash_idx ON search_history(query_hash);

-- Precomputed seed cache. One row per (seed, mc_version, large_biomes).
-- Bitmask columns are computed by seed_precompute and matched at query time
-- with AND.
CREATE TABLE IF NOT EXISTS seed_cache (
    seed              BIGINT      NOT NULL,
    mc_version        TEXT        NOT NULL,
    large_biomes      BOOLEAN     NOT NULL DEFAULT FALSE,
    biome_mask_100    BIGINT      NOT NULL,
    struct_mask_100   BIGINT      NOT NULL,
    biome_mask_200    BIGINT      NOT NULL,
    struct_mask_200   BIGINT      NOT NULL,
    biome_mask_500    BIGINT      NOT NULL,
    struct_mask_500   BIGINT      NOT NULL,
    biome_mask_1000   BIGINT      NOT NULL,
    struct_mask_1000  BIGINT      NOT NULL,
    source            TEXT        NOT NULL DEFAULT 'precompute',
    added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (seed, mc_version, large_biomes)
);

-- Functional indexes per radius so that bitmask AND filters can be range
-- scanned. The covering index lets us pick a candidate seed in O(log n).
CREATE INDEX IF NOT EXISTS seed_cache_mc_100_idx
    ON seed_cache(mc_version, large_biomes, biome_mask_100, struct_mask_100);
CREATE INDEX IF NOT EXISTS seed_cache_mc_200_idx
    ON seed_cache(mc_version, large_biomes, biome_mask_200, struct_mask_200);
CREATE INDEX IF NOT EXISTS seed_cache_mc_500_idx
    ON seed_cache(mc_version, large_biomes, biome_mask_500, struct_mask_500);
CREATE INDEX IF NOT EXISTS seed_cache_mc_1000_idx
    ON seed_cache(mc_version, large_biomes, biome_mask_1000, struct_mask_1000);
CREATE INDEX IF NOT EXISTS seed_cache_added_idx ON seed_cache(added_at DESC);

-- Query result memoization. canonical_hash = sha256(mc | radius | biomes |
-- structures | large). Multiple seeds per hash stored to power "find another"
-- without re-running the worker.
CREATE TABLE IF NOT EXISTS query_memo (
    query_hash      TEXT        NOT NULL,
    seed            BIGINT      NOT NULL,
    result_payload  JSONB       NOT NULL,
    source          TEXT        NOT NULL,
    ttl_expires     TIMESTAMPTZ,
    hit_count       INTEGER     NOT NULL DEFAULT 0,
    last_hit_at     TIMESTAMPTZ,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (query_hash, seed)
);

CREATE INDEX IF NOT EXISTS query_memo_hash_idx ON query_memo(query_hash);
CREATE INDEX IF NOT EXISTS query_memo_ttl_idx ON query_memo(ttl_expires)
    WHERE ttl_expires IS NOT NULL;

-- Demand counters power adaptive background precompute. The bot increments
-- on each query; the precompute scheduler reads this table to decide what
-- combinations to compute next.
CREATE TABLE IF NOT EXISTS query_demand (
    query_hash      TEXT        PRIMARY KEY,
    biome_mask      BIGINT      NOT NULL,
    structure_mask  BIGINT      NOT NULL,
    radius          INTEGER     NOT NULL,
    mc_version      TEXT        NOT NULL,
    large_biomes    BOOLEAN     NOT NULL,
    request_count   INTEGER     NOT NULL DEFAULT 0,
    cache_misses    INTEGER     NOT NULL DEFAULT 0,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS query_demand_misses_idx ON query_demand(cache_misses DESC);
CREATE INDEX IF NOT EXISTS query_demand_last_seen_idx ON query_demand(last_seen_at DESC);

COMMIT;
