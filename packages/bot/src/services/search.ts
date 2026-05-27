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
import { liveSearchSemaphore } from "./concurrency.js";
import { pool } from "./db.js";
import { recordSearchMetric } from "./metrics.js";
import { enrichSeedCache } from "./precompute_scheduler.js";
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

export interface LiveSearchCallbacks {
  /** Called when the request enters the semaphore queue. 1-based. */
  onQueued?: (position: number) => void;
  /** Called every time the user's queue position improves (0 = next). */
  onPositionChanged?: (position: number) => void;
  /** Called once the slot is acquired and the worker is about to spawn. */
  onSearchStarted?: () => void;
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
  liveCallbacks?: LiveSearchCallbacks;
  /** When false, never run a live worker (free-tier caps). */
  allowLiveSearch?: boolean;
  /**
   * When set, aborting the signal cancels the live search: if still
   * queued, removes the waiter; if already running, sends SIGTERM to
   * the worker. Has no effect on cache/memo lookups.
   */
  cancelSignal?: AbortSignal;
  /**
   * Marks the request as originating from a background job (explorer,
   * backfill, curated warmer). Background requests are excluded from
   * user-facing performance stats so the operator sees the experience
   * real users get, not the synthetic load we generate ourselves.
   */
  isBackground?: boolean;
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
    void recordSearchMetric({
      userId: input.userId,
      queryHash: hash,
      source: outcome.source,
      elapsedMs: elapsed,
      seedsTested: 0,
      found: true,
      radius: input.radius.blocks,
      mcVersion: input.mc,
      isBackground: input.isBackground === true,
    });
    return { ok: true, outcome };
  }
  await recordDemand({ hash, q, cacheMiss: true });

  if (input.allowLiveSearch === false) {
    return { ok: false, reason: "live_disabled" };
  }

  // Live worker fallback — gated by the live-search semaphore so we never
  // run more than `liveSearchConcurrency` cubiomes processes at once.
  const queueDepthBeforeAcquire = liveSearchSemaphore.queued;
  if (queueDepthBeforeAcquire > 0 || liveSearchSemaphore.inFlight >= liveSearchSemaphore.limit) {
    logger.info(
      {
        hash: hash.slice(0, 16),
        inFlight: liveSearchSemaphore.inFlight,
        queued: queueDepthBeforeAcquire,
        limit: liveSearchSemaphore.limit,
      },
      "live search queued",
    );
  }

  let outcome: WorkerOutcome;
  try {
    outcome = await liveSearchSemaphore.withSlot(
      async () => {
        /* Slot granted — tell the bot it's our turn so the UI flips
         * from "queued" to "searching". */
        input.liveCallbacks?.onSearchStarted?.();
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
        /* Forward cancellation: once the slot is acquired, the abort
         * signal stops affecting the queue — instead, we send SIGTERM
         * to the running worker so it exits with a `cancelled` line. */
        const onCancelWorker = (): void => job.cancel();
        input.cancelSignal?.addEventListener("abort", onCancelWorker, { once: true });
        try {
          return await job.wait();
        } finally {
          input.cancelSignal?.removeEventListener("abort", onCancelWorker);
        }
      },
      {
        signal: input.cancelSignal,
        onQueued: input.liveCallbacks?.onQueued,
        onPositionChanged: input.liveCallbacks?.onPositionChanged,
      },
    );
  } catch (err) {
    /* Cancellation while still in the queue (semaphore rejected the
     * acquire). Cache/memo lookups already completed without a credit
     * debit. Surface as a regular cancelled outcome so the handler
     * doesn't need to special-case error vs. cancel. */
    if (input.cancelSignal?.aborted) {
      return { ok: false, reason: "cancelled" };
    }
    throw err;
  }
  if (outcome.kind === "result") {
    const r = outcome.message;
    await memoizeResult({
      hash,
      seed: BigInt(r.seed),
      payload: r as unknown as Record<string, unknown>,
      source: "live",
      ttlSeconds: config.cacheTtlSeconds,
    });
    // Full bitmask enrichment in background (doesn't block user response).
    enrichSeedCache(BigInt(r.seed), input.mc, input.largeBiomes).catch((err) =>
      logger.error({ err }, "enrichSeedCache failed"),
    );
    void recordSearchMetric({
      userId: input.userId,
      queryHash: hash,
      source: "live",
      elapsedMs: Number(r.elapsed_ms ?? 0),
      seedsTested: Number(r.seeds_tested ?? 0),
      found: true,
      radius: input.radius.blocks,
      mcVersion: input.mc,
      isBackground: input.isBackground === true,
    });
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
    void recordSearchMetric({
      userId: input.userId,
      queryHash: hash,
      source: "not_found",
      elapsedMs: Number(outcome.message.elapsed_ms ?? 0),
      seedsTested: Number(outcome.message.seeds_tested ?? 0),
      found: false,
      radius: input.radius.blocks,
      mcVersion: input.mc,
      isBackground: input.isBackground === true,
    });
    return {
      ok: false,
      reason: "not_found",
      detail: outcome.message.reason,
      seedsTested: Number(outcome.message.seeds_tested),
      elapsedMs: Number(outcome.message.elapsed_ms),
    };
  }
  if (outcome.kind === "cancelled") {
    void recordSearchMetric({
      userId: input.userId,
      queryHash: hash,
      source: "cancelled",
      elapsedMs: 0,
      seedsTested: 0,
      found: false,
      radius: input.radius.blocks,
      mcVersion: input.mc,
      isBackground: input.isBackground === true,
    });
    return { ok: false, reason: "cancelled" };
  }
  return { ok: false, reason: "error", detail: outcome.message.message };
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
