-- Persistent picker-wizard state.
--
-- Previously the user's biome/structure picks lived in an in-memory Map
-- keyed by chat_id. A bot restart cleared it, which made stale inline
-- buttons ("Найти другой") issue searches with the default empty
-- criteria (no biomes, no structures, radius 500) — returning a
-- seemingly random cache hit. Now we persist the state so a restart
-- doesn't break already-opened result messages.
--
-- Rows are upserted on every state change and lazily reaped after 30
-- days of inactivity by a cleanup job; for now the bot just leaves
-- them around (storage is negligible).

BEGIN;

CREATE TABLE IF NOT EXISTS picker_state (
    chat_id        BIGINT      PRIMARY KEY,
    version        TEXT        NOT NULL,
    radius         INTEGER     NOT NULL,
    biome_ids      TEXT[]      NOT NULL DEFAULT '{}',
    structure_ids  TEXT[]      NOT NULL DEFAULT '{}',
    exclude_seeds  TEXT[]      NOT NULL DEFAULT '{}',
    page_biomes    INTEGER     NOT NULL DEFAULT 0,
    page_structures INTEGER    NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS picker_state_updated_idx
    ON picker_state(updated_at DESC);

COMMIT;
