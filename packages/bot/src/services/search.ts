/**
 * Search orchestration — the layered fast-path → fallback flow.
 *
 * 1. Look up the canonical request hash in `query_memo` for an exact
 *    previously-served seed (10ms).
 * 2. Look up the seed cache for any precomputed seed satisfying the bitmask
 *    intersection (10ms).
 * 3. If both miss, spawn the C worker for a live, multi-threaded search.
 *
 * Independent of the outcome, every request is recorded in `query_demand`
 * so that the adaptive precompute scheduler can prioritise the most
 * commonly-missed combinations for future precompute work.
 */

import { performance } from "node:perf_hooks";

import {
  BIOMES,
  type McVersion,
  type RadiusInfo,
  STRUCTURES,
  biomeMask,
  structureMask,
} from "@kruto52/shared";

import { config } from "../config.js";
import { logger } from "../logger.js";

import {
  type CacheQuery,
  canonicalQueryHash,
  findCachedSeed,
  memoizeResult,
  recordDemand,
} from "./cache.js";
import { pool } from "./db.js";
import { resolveSeed, runWorker, type WorkerCallbacks, type WorkerOutcome } from "./worker.js";

export interface ResolvedSeedPos {
  id: string;
  nameRu: string;
  x: number;
  z: number;
}

export interface SearchOutcome {
  source: "memo" | "cache" | "live";
  seed: bigint;
  biomes: ResolvedSeedPos[];
  structures: ResolvedSeedPos[];
  elapsedMs: number;
  seedsTested: number;
}

export interface SearchInput {
  userId: number;
  mc: McVersion;
  largeBiomes: boolean;
  radius: RadiusInfo;
  biomeIds: readonly string[];
  structureIds: readonly string[];
  excludeSeeds?: ReadonlyArray<bigint>;
  timeoutMs?: number;
  callbacks?: WorkerCallbacks;
  /** When false, never run a live worker (free-tier caps). */
  allowLiveSearch?: boolean;
}

export type SearchResult =
  | { ok: true; outcome: SearchOutcome }
  | {
      ok: false;
      reason: "no_credits" | "live_disabled" | "not_found" | "cancelled" | "error";
      detail?: string;
      /** Set when reason is "not_found": diagnostics for the UI. */
      seedsTested?: number;
      elapsedMs?: number;
    };

function bigSet(values?: ReadonlyArray<bigint>): Set<bigint> {
  return new Set(values ?? []);
}

/** JSON.stringify that survives BigInt values (Postgres `jsonb` payloads). */
function jsonbStringify(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

function resolveBiomes(rawIds: readonly string[]): ResolvedSeedPos[] {
  const out: ResolvedSeedPos[] = [];
  for (const id of rawIds) {
    const b = BIOMES.find((x) => x.id === id);
    if (b) out.push({ id, nameRu: b.nameRu, x: 0, z: 0 });
  }
  return out;
}

function resolveStructs(rawIds: readonly string[]): ResolvedSeedPos[] {
  const out: ResolvedSeedPos[] = [];
  for (const id of rawIds) {
    const s = STRUCTURES.find((x) => x.id === id);
    if (s) out.push({ id, nameRu: s.nameRu, x: 0, z: 0 });
  }
  return out;
}

/**
 * Resolves a seed for a user request using cache → live worker fallback.
 *
 * This function does NOT debit credits — that decision lives in the bot
 * handler so it can be tied to user UI state. Pass `allowLiveSearch=false`
 * to limit a request to cache hits only.
 */
export async function findSeed(input: SearchInput): Promise<SearchResult> {
  const t0 = performance.now();
  const bm = biomeMask(input.biomeIds);
  const sm = structureMask(input.structureIds);
  const q: CacheQuery = {
    mc: input.mc,
    largeBiomes: input.largeBiomes,
    radius: input.radius,
    biomeMask: bm,
    structureMask: sm,
    excludeSeeds: bigSet(input.excludeSeeds),
  };
  const hash = canonicalQueryHash({
    mc: input.mc,
    largeBiomes: input.largeBiomes,
    radiusBlocks: input.radius.blocks,
    biomeMask: bm,
    structureMask: sm,
  });

  const cached = await findCachedSeed(q);
  if (cached) {
    await recordDemand({ hash, q, cacheMiss: false });
    /* Cache rows store only bitmasks, not coordinates. Probe the seed via
     * the worker in `resolve` mode to get real positions; this takes a few
     * milliseconds and means the result message no longer shows 0,0 for
     * everything. */
    const resolved = await resolveSeed({
      id: hash.slice(0, 16),
      mc: input.mc,
      large_biomes: input.largeBiomes,
      radius: input.radius.blocks,
      biomes: [...input.biomeIds],
      structures: [...input.structureIds],
      exclude_seeds: [],
      max_seeds: 1,
      timeout_ms: 5_000,
      seed: cached.seed.toString(),
    });
    const elapsed = Math.round(performance.now() - t0);
    let biomesOut: ResolvedSeedPos[];
    let structuresOut: ResolvedSeedPos[];
    if (resolved.type === "result" && (resolved.biomes.length || resolved.structures.length)) {
      biomesOut = resolved.biomes.map((b) => ({
        id: b.id,
        nameRu: BIOMES.find((x) => x.id === b.id)?.nameRu ?? b.id,
        x: b.x,
        z: b.z,
      }));
      structuresOut = resolved.structures.map((s) => ({
        id: s.id,
        nameRu: STRUCTURES.find((x) => x.id === s.id)?.nameRu ?? s.id,
        x: s.x,
        z: s.z,
      }));
    } else {
      /* Resolve failed — fall back to the bare list without coordinates. */
      biomesOut = resolveBiomes(input.biomeIds);
      structuresOut = resolveStructs(input.structureIds);
    }
    const outcome: SearchOutcome = {
      source: cached.source === "memo" ? "memo" : "cache",
      seed: cached.seed,
      biomes: biomesOut,
      structures: structuresOut,
      elapsedMs: elapsed,
      seedsTested: 0,
    };
    return { ok: true, outcome };
  }
  await recordDemand({ hash, q, cacheMiss: true });

  if (input.allowLiveSearch === false) {
    return { ok: false, reason: "live_disabled" };
  }

  // Live worker fallback.
  const job = runWorker(
    {
      id: hash.slice(0, 16),
      mc: input.mc,
      large_biomes: input.largeBiomes,
      radius: input.radius.blocks,
      biomes: [...input.biomeIds],
      structures: [...input.structureIds],
      exclude_seeds: (input.excludeSeeds ?? []).map((v) => v.toString()),
      max_seeds: config.defaultMaxSeeds,
      timeout_ms: input.timeoutMs ?? config.defaultTimeoutMs,
      threads: config.defaultThreads || undefined,
    },
    input.callbacks ?? {},
  );

  const outcome: WorkerOutcome = await job.wait();
  if (outcome.kind === "result") {
    const r = outcome.message;
    await memoizeResult({
      hash,
      seed: BigInt(r.seed),
      payload: r as unknown as Record<string, unknown>,
      source: "live",
      ttlSeconds: config.cacheTtlSeconds,
    });
    // Also persist to seed_cache as a side effect for future bitmask hits.
    await persistResultToCache(input, BigInt(r.seed));
    return {
      ok: true,
      outcome: {
        source: "live",
        seed: BigInt(r.seed),
        biomes: r.biomes.map((b) => ({
          id: b.id,
          nameRu: BIOMES.find((x) => x.id === b.id)?.nameRu ?? b.id,
          x: b.x,
          z: b.z,
        })),
        structures: r.structures.map((s) => ({
          id: s.id,
          nameRu: STRUCTURES.find((x) => x.id === s.id)?.nameRu ?? s.id,
          x: s.x,
          z: s.z,
        })),
        elapsedMs: r.elapsed_ms,
        seedsTested: r.seeds_tested,
      },
    };
  }
  if (outcome.kind === "not_found") {
    return {
      ok: false,
      reason: "not_found",
      detail: outcome.message.reason,
      seedsTested: Number(outcome.message.seeds_tested),
      elapsedMs: Number(outcome.message.elapsed_ms),
    };
  }
  if (outcome.kind === "cancelled") {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "error", detail: outcome.message.message };
}

/** Inserts a minimal seed_cache row when a live search succeeds. */
async function persistResultToCache(input: SearchInput, seed: bigint): Promise<void> {
  // Build masks for ALL biomes/structures the user requested, at all four
  // radii. Since we only know the result fits the user's radius, we keep
  // the bits set only in that bucket. This is conservative but cheap.
  // The background precompute pipeline later fills in the other buckets.
  const bm = biomeMask(input.biomeIds);
  const sm = structureMask(input.structureIds);
  const cols: Record<string, string> = {
    biome_mask_100: "0",
    struct_mask_100: "0",
    biome_mask_200: "0",
    struct_mask_200: "0",
    biome_mask_500: "0",
    struct_mask_500: "0",
    biome_mask_1000: "0",
    struct_mask_1000: "0",
  };
  cols[`biome_mask_${input.radius.blocks}`] = bm.toString();
  cols[`struct_mask_${input.radius.blocks}`] = sm.toString();

  await pool
    .query(
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
               'live')
       ON CONFLICT (seed, mc_version, large_biomes) DO UPDATE SET
           biome_mask_100   = seed_cache.biome_mask_100   | EXCLUDED.biome_mask_100,
           struct_mask_100  = seed_cache.struct_mask_100  | EXCLUDED.struct_mask_100,
           biome_mask_200   = seed_cache.biome_mask_200   | EXCLUDED.biome_mask_200,
           struct_mask_200  = seed_cache.struct_mask_200  | EXCLUDED.struct_mask_200,
           biome_mask_500   = seed_cache.biome_mask_500   | EXCLUDED.biome_mask_500,
           struct_mask_500  = seed_cache.struct_mask_500  | EXCLUDED.struct_mask_500,
           biome_mask_1000  = seed_cache.biome_mask_1000  | EXCLUDED.biome_mask_1000,
           struct_mask_1000 = seed_cache.struct_mask_1000 | EXCLUDED.struct_mask_1000`,
      [
        seed.toString(),
        input.mc,
        input.largeBiomes,
        cols.biome_mask_100,
        cols.struct_mask_100,
        cols.biome_mask_200,
        cols.struct_mask_200,
        cols.biome_mask_500,
        cols.struct_mask_500,
        cols.biome_mask_1000,
        cols.struct_mask_1000,
      ],
    )
    .catch((err) => logger.error({ err }, "failed to persist live result to cache"));
}

/** Persists the search to `search_history`. */
export async function recordSearchHistory(input: {
  userId: number;
  mc: McVersion;
  largeBiomes: boolean;
  radius: RadiusInfo;
  biomeIds: readonly string[];
  structureIds: readonly string[];
  result: SearchResult;
  debited: number;
}): Promise<void> {
  const bm = biomeMask(input.biomeIds);
  const sm = structureMask(input.structureIds);
  const hash = canonicalQueryHash({
    mc: input.mc,
    largeBiomes: input.largeBiomes,
    radiusBlocks: input.radius.blocks,
    biomeMask: bm,
    structureMask: sm,
  });
  let resultSeed: string | null = null;
  let payload: unknown = null;
  let elapsed: number | null = null;
  let tested: number | null = null;
  let source = "miss";
  if (input.result.ok) {
    resultSeed = input.result.outcome.seed.toString();
    payload = input.result.outcome;
    elapsed = input.result.outcome.elapsedMs;
    tested = input.result.outcome.seedsTested;
    source = input.result.outcome.source;
  } else {
    source = `failed:${input.result.reason}`;
  }
  try {
    await pool.query(
      `INSERT INTO search_history (
         user_id, mc_version, large_biomes, radius, biome_mask, structure_mask,
         query_hash, source, result_seed, result_payload, elapsed_ms,
         seeds_tested, debited_credits)
       VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint,
               $7, $8, $9::bigint, $10::jsonb, $11, $12, $13)`,
      [
        input.userId,
        input.mc,
        input.largeBiomes,
        input.radius.blocks,
        bm.toString(),
        sm.toString(),
        hash,
        source,
        resultSeed,
        jsonbStringify(payload),
        elapsed,
        tested,
        input.debited,
      ],
    );
  } catch (err) {
    // History logging is best-effort: never let it block the user-facing
    // result message in the handler.
    logger.error({ err }, "recordSearchHistory failed");
  }
}
