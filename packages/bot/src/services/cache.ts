/**
 * Seed cache + query memoization service.
 *
 * Two storage layers feed the search path:
 *
 *   1. `query_memo` — exact-match cache keyed on the canonical SHA-256 of
 *      the request. Returns previously delivered seeds for identical queries.
 *      Lookup time: O(log n) on a single key.
 *
 *   2. `seed_cache` — precomputed `(seed, version)` rows with per-radius
 *      bitmask columns. A query like "village within 500 blocks of plains"
 *      compiles into `(biome_mask_500 & $1) = $1 AND (struct_mask_500 & $2)
 *      = $2`, indexed by `seed_cache_mc_500_idx`.
 *
 * The bot calls `findCachedSeed` first; if it returns null, it falls back
 * to the C worker and stores the result back into both layers.
 */

import { createHash } from "node:crypto";

import { type McVersion, type RadiusInfo, getRadius } from "@kruto52/shared";

import { pool } from "./db.js";

export interface CacheQuery {
  mc: McVersion;
  largeBiomes: boolean;
  radius: RadiusInfo;
  biomeMask: bigint;
  structureMask: bigint;
  excludeSeeds?: ReadonlySet<bigint>;
}

export interface CachedSeedRow {
  seed: bigint;
  source: string;
  payload: Record<string, unknown> | null;
}

export function canonicalQueryHash(input: {
  mc: McVersion;
  largeBiomes: boolean;
  radiusBlocks: number;
  biomeMask: bigint;
  structureMask: bigint;
}): string {
  const s = `${input.mc}|${input.largeBiomes ? 1 : 0}|${input.radiusBlocks}|${input.biomeMask.toString(16)}|${input.structureMask.toString(16)}`;
  return createHash("sha256").update(s).digest("hex");
}

function colsForRadius(radius: RadiusInfo): { bm: string; sm: string } {
  return {
    bm: `biome_mask_${radius.blocks}`,
    sm: `struct_mask_${radius.blocks}`,
  };
}

/** Looks up a memoized seed first, then a cache row. Returns null on miss. */
export async function findCachedSeed(q: CacheQuery): Promise<CachedSeedRow | null> {
  const hash = canonicalQueryHash({
    mc: q.mc,
    largeBiomes: q.largeBiomes,
    radiusBlocks: q.radius.blocks,
    biomeMask: q.biomeMask,
    structureMask: q.structureMask,
  });
  const excludeArr = q.excludeSeeds ? Array.from(q.excludeSeeds, (v) => v.toString()) : [];

  // 1. Memo
  const memo = await pool.query<{ seed: string; result_payload: Record<string, unknown> }>(
    `UPDATE query_memo
        SET hit_count = hit_count + 1,
            last_hit_at = NOW()
      WHERE query_hash = $1
        AND (ttl_expires IS NULL OR ttl_expires > NOW())
        AND seed::text <> ALL($2::text[])
      RETURNING seed::text, result_payload`,
    [hash, excludeArr],
  );
  if (memo.rowCount && memo.rowCount > 0) {
    const row = memo.rows[0]!;
    return { seed: BigInt(row.seed), source: "memo", payload: row.result_payload };
  }

  // 2. Seed cache (bitmask AND)
  const { bm, sm } = colsForRadius(q.radius);
  const cache = await pool.query<{ seed: string; source: string }>(
    `SELECT seed::text, source
       FROM seed_cache
      WHERE mc_version = $1
        AND large_biomes = $2
        AND (${bm} & $3::bigint) = $3::bigint
        AND (${sm} & $4::bigint) = $4::bigint
        AND seed::text <> ALL($5::text[])
      ORDER BY added_at DESC
      LIMIT 1`,
    [
      q.mc,
      q.largeBiomes,
      q.biomeMask.toString(),
      q.structureMask.toString(),
      excludeArr,
    ],
  );
  if (cache.rowCount && cache.rowCount > 0) {
    const row = cache.rows[0]!;
    return { seed: BigInt(row.seed), source: row.source, payload: null };
  }
  return null;
}

/** Persists a seed result into the memo for future fast retrieval. */
export async function memoizeResult(input: {
  hash: string;
  seed: bigint;
  payload: Record<string, unknown>;
  source: string;
  ttlSeconds: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO query_memo (query_hash, seed, result_payload, source, ttl_expires)
     VALUES ($1, $2::bigint, $3::jsonb, $4, NOW() + ($5 || ' seconds')::interval)
     ON CONFLICT (query_hash, seed) DO UPDATE SET
       result_payload = EXCLUDED.result_payload,
       last_hit_at    = NOW(),
       ttl_expires    = EXCLUDED.ttl_expires`,
    [
      input.hash,
      input.seed.toString(),
      JSON.stringify(input.payload, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
      input.source,
      String(input.ttlSeconds),
    ],
  );
}

/** Records demand for a query for adaptive precompute. */
export async function recordDemand(input: {
  hash: string;
  q: CacheQuery;
  cacheMiss: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO query_demand (
        query_hash, biome_mask, structure_mask, radius, mc_version,
        large_biomes, request_count, cache_misses, last_seen_at)
     VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, 1, $7, NOW())
     ON CONFLICT (query_hash) DO UPDATE SET
       request_count = query_demand.request_count + 1,
       cache_misses  = query_demand.cache_misses + EXCLUDED.cache_misses,
       last_seen_at  = NOW()`,
    [
      input.hash,
      input.q.biomeMask.toString(),
      input.q.structureMask.toString(),
      input.q.radius.blocks,
      input.q.mc,
      input.q.largeBiomes,
      input.cacheMiss ? 1 : 0,
    ],
  );
}

/** Used by the precompute pipeline to bulk insert cache rows. */
export async function insertSeedCacheRow(input: {
  seed: bigint;
  mc: McVersion;
  largeBiomes: boolean;
  masks: Record<string, bigint>;
  source: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO seed_cache (
        seed, mc_version, large_biomes,
        biome_mask_100, struct_mask_100,
        biome_mask_200, struct_mask_200,
        biome_mask_500, struct_mask_500,
        biome_mask_1000, struct_mask_1000,
        source)
     VALUES ($1::bigint, $2, $3,
             $4::bigint, $5::bigint,
             $6::bigint, $7::bigint,
             $8::bigint, $9::bigint,
             $10::bigint, $11::bigint,
             $12)
     ON CONFLICT (seed, mc_version, large_biomes) DO NOTHING`,
    [
      input.seed.toString(),
      input.mc,
      input.largeBiomes,
      input.masks.biome_mask_100!.toString(),
      input.masks.struct_mask_100!.toString(),
      input.masks.biome_mask_200!.toString(),
      input.masks.struct_mask_200!.toString(),
      input.masks.biome_mask_500!.toString(),
      input.masks.struct_mask_500!.toString(),
      input.masks.biome_mask_1000!.toString(),
      input.masks.struct_mask_1000!.toString(),
      input.source,
    ],
  );
}

/** Upsert a seed_cache row, OR-merging bitmask bits with any existing row. */
export async function upsertSeedCacheFull(input: {
  seed: bigint;
  mc: McVersion;
  largeBiomes: boolean;
  masks: Record<string, bigint>;
  source: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO seed_cache (
        seed, mc_version, large_biomes,
        biome_mask_100, struct_mask_100,
        biome_mask_200, struct_mask_200,
        biome_mask_500, struct_mask_500,
        biome_mask_1000, struct_mask_1000,
        source)
     VALUES ($1::bigint, $2, $3,
             $4::bigint, $5::bigint,
             $6::bigint, $7::bigint,
             $8::bigint, $9::bigint,
             $10::bigint, $11::bigint,
             $12)
     ON CONFLICT (seed, mc_version, large_biomes) DO UPDATE SET
         biome_mask_100   = seed_cache.biome_mask_100   | EXCLUDED.biome_mask_100,
         struct_mask_100  = seed_cache.struct_mask_100  | EXCLUDED.struct_mask_100,
         biome_mask_200   = seed_cache.biome_mask_200   | EXCLUDED.biome_mask_200,
         struct_mask_200  = seed_cache.struct_mask_200  | EXCLUDED.struct_mask_200,
         biome_mask_500   = seed_cache.biome_mask_500   | EXCLUDED.biome_mask_500,
         struct_mask_500  = seed_cache.struct_mask_500  | EXCLUDED.struct_mask_500,
         biome_mask_1000  = seed_cache.biome_mask_1000  | EXCLUDED.biome_mask_1000,
         struct_mask_1000 = seed_cache.struct_mask_1000 | EXCLUDED.struct_mask_1000,
         source = EXCLUDED.source`,
    [
      input.seed.toString(),
      input.mc,
      input.largeBiomes,
      input.masks.biome_mask_100.toString(),
      input.masks.struct_mask_100.toString(),
      input.masks.biome_mask_200.toString(),
      input.masks.struct_mask_200.toString(),
      input.masks.biome_mask_500.toString(),
      input.masks.struct_mask_500.toString(),
      input.masks.biome_mask_1000.toString(),
      input.masks.struct_mask_1000.toString(),
      input.source,
    ],
  );
}

/** Helper to get radius from blocks for callers using the shared catalog. */
export function radiusFromBlocks(blocks: number): RadiusInfo {
  return getRadius(String(blocks));
}
