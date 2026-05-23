# Database

PostgreSQL 15+. All schema changes go in `db/migrations/NNN_description.sql`
(numbered, never reordered, never edited after merge).

Applied automatically on bot startup via the simple migrator in
`packages/bot/src/services/db.ts` — see `migrate()`. The migrator records
applied filenames in a `schema_migrations` table.

## Tables

| Table | Purpose |
|---|---|
| `users` | Telegram profile, credit balance, Pro expiry, daily free counter. |
| `credits_ledger` | Append-only credit movements with `idempotency_key`. |
| `billing_audit_log` | Every payment event (Stars / CryptoBot), regardless of outcome. |
| `search_history` | One row per accepted search, with the resolved seed if any. |
| `seed_cache` | Precomputed `(seed, version, large_biomes)` rows with per-radius bitmasks of biomes and structures present. The hot path of the bot. |
| `query_memo` | `sha256(request)` → already-found seeds with hit counters. |
| `query_demand` | Counter of how often each canonical query is requested; consumed by the adaptive precompute scheduler. |

## Why bitmasks?

Cache lookups for "does this seed have biome X and structure Y within
radius R" reduce to a single `AND` on two `BIGINT` columns. With the partial
indexes per radius, a query like

```sql
SELECT seed FROM seed_cache
 WHERE mc_version = '1.21'
   AND large_biomes = false
   AND (biome_mask_500 & $1) = $1
   AND (struct_mask_500 & $2) = $2
 LIMIT 1;
```

returns in single-digit milliseconds even with millions of seeds.

We keep one mask column per radius (100/200/500/1000) so that querying for
"village within 100 blocks" doesn't false-positive against "village within
1000 blocks" cached on the same seed.
