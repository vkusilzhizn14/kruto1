/**
 * Adaptive background precompute scheduler.
 *
 * Periodically wakes up, finds the queries that miss the cache most often,
 * spawns the C precompute binary with a small batch of seeds, and ingests
 * the resulting bitmask rows into `seed_cache`. Over time the cache shape
 * tracks real user demand.
 *
 * Conservative defaults: small batches every 10 minutes so the worker
 * doesn't fight the live request path for CPU.
 */

import { spawn } from "node:child_process";

import type { McVersion } from "@kruto52/shared";

import { config } from "../config.js";
import { logger } from "../logger.js";

import { insertSeedCacheRow, upsertSeedCacheFull } from "./cache.js";
import { liveSearchSemaphore } from "./concurrency.js";
import { pool } from "./db.js";

interface PrecomputeRow {
  seed: string;
  mc: McVersion;
  large: number;
  biome_mask_100: string;
  struct_mask_100: string;
  biome_mask_200: string;
  struct_mask_200: string;
  biome_mask_500: string;
  struct_mask_500: string;
  biome_mask_1000: string;
  struct_mask_1000: string;
}

async function pickTargetVersion(): Promise<McVersion> {
  const { rows } = await pool.query<{ mc_version: McVersion }>(
    `SELECT mc_version
       FROM query_demand
      ORDER BY cache_misses DESC
      LIMIT 1`,
  );
  return rows[0]?.mc_version ?? "1.21";
}

export async function runPrecomputeBatch(): Promise<number> {
  const mc = await pickTargetVersion();
  const startSeed = BigInt(Math.floor(Math.random() * 2 ** 32));
  const count = config.precomputeBatchSize;
  return await new Promise<number>((resolve, reject) => {
    const proc = spawn(
      config.precomputePath,
      [mc, "0", String(count), startSeed.toString(), String(Math.max(1, config.defaultThreads || 2))],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let buf = "";
    let inserted = 0;
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let r: PrecomputeRow;
        try {
          r = JSON.parse(line) as PrecomputeRow;
        } catch (err) {
          logger.warn({ err, line }, "precompute parse error");
          continue;
        }
        insertSeedCacheRow({
          seed: BigInt(r.seed),
          mc: r.mc,
          largeBiomes: r.large !== 0,
          masks: {
            biome_mask_100: BigInt(r.biome_mask_100),
            struct_mask_100: BigInt(r.struct_mask_100),
            biome_mask_200: BigInt(r.biome_mask_200),
            struct_mask_200: BigInt(r.struct_mask_200),
            biome_mask_500: BigInt(r.biome_mask_500),
            struct_mask_500: BigInt(r.struct_mask_500),
            biome_mask_1000: BigInt(r.biome_mask_1000),
            struct_mask_1000: BigInt(r.struct_mask_1000),
          },
          source: "precompute",
        })
          .then(() => {
            inserted++;
          })
          .catch((err) => logger.warn({ err }, "insertSeedCacheRow failed"));
      }
    });
    proc.stderr.on("data", (chunk: Buffer) =>
      logger.debug({ stderr: chunk.toString("utf8").trim() }, "precompute stderr"),
    );
    proc.on("error", reject);
    proc.on("close", () => resolve(inserted));
  });
}

/**
 * Compute the full bitmask for a single known seed via seed_enrich
 * and upsert it into seed_cache. Fire-and-forget safe.
 */
export async function enrichSeedCache(
  seed: bigint,
  mc: McVersion,
  largeBiomes: boolean,
): Promise<void> {
  if (!config.enrichLiveResults) return;
  return new Promise<void>((resolve) => {
    const proc = spawn(
      config.enrichPath,
      [mc, largeBiomes ? "1" : "0", seed.toString()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let buf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) =>
      logger.debug({ stderr: chunk.toString("utf8").trim() }, "enrich stderr"),
    );
    proc.on("error", (err) => {
      logger.warn({ err, seed: seed.toString() }, "enrichSeedCache spawn error");
      resolve();
    });
    proc.on("close", () => {
      const line = buf.trim();
      if (!line) {
        resolve();
        return;
      }
      let r: PrecomputeRow;
      try {
        r = JSON.parse(line) as PrecomputeRow;
      } catch (err) {
        logger.warn({ err }, "enrichSeedCache parse error");
        resolve();
        return;
      }
      upsertSeedCacheFull({
        seed: BigInt(r.seed),
        mc: r.mc,
        largeBiomes: r.large !== 0,
        masks: {
          biome_mask_100: BigInt(r.biome_mask_100),
          struct_mask_100: BigInt(r.struct_mask_100),
          biome_mask_200: BigInt(r.biome_mask_200),
          struct_mask_200: BigInt(r.struct_mask_200),
          biome_mask_500: BigInt(r.biome_mask_500),
          struct_mask_500: BigInt(r.struct_mask_500),
          biome_mask_1000: BigInt(r.biome_mask_1000),
          struct_mask_1000: BigInt(r.struct_mask_1000),
        },
        source: "enriched",
      })
        .then(() => resolve())
        .catch((err) => {
          logger.warn({ err }, "enrichSeedCache insert failed");
          resolve();
        });
    });
  });
}

export function startPrecomputeLoop(): void {
  if (!config.precomputeEnabled) return;
  const tick = async (): Promise<void> => {
    try {
      const n = await runPrecomputeBatch();
      logger.info({ inserted: n }, "precompute batch finished");
    } catch (err) {
      logger.warn({ err }, "precompute batch failed");
    }
  };
  // Fire once at boot after a small delay, then on interval.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), config.precomputeIntervalSec * 1000);
  }, 15_000);
}

/* ----------------------- backfill enrichment ----------------------- */

let backfillTotalEnriched = 0;
let backfillTotalSkipped = 0;

export function backfillStats(): {
  enriched: number;
  skipped: number;
} {
  return { enriched: backfillTotalEnriched, skipped: backfillTotalSkipped };
}

/**
 * Enrich one historic `seed_cache` row whose full bitmask was never
 * computed (`enriched_at IS NULL` or rows that were inserted as
 * `precompute`). The full bitmask covers every biome and structure at
 * every supported radius, so a single enriched row can answer many
 * different future queries from cache instead of forcing a live worker
 * spawn.
 *
 * Yields to live users: if the live-search semaphore has anyone in
 * flight or queued, this tick is skipped entirely. Picks the oldest
 * never-enriched row first so the backlog drains in insertion order.
 */
export async function backfillTick(): Promise<"ok" | "skipped" | "empty" | "failed"> {
  if (liveSearchSemaphore.queued > 0 || liveSearchSemaphore.inFlight > 0) {
    backfillTotalSkipped++;
    return "skipped";
  }
  const { rows } = await pool.query<{
    seed: string;
    mc_version: McVersion;
    large_biomes: boolean;
  }>(
    `SELECT seed::text, mc_version, large_biomes
       FROM seed_cache
      WHERE enriched_at IS NULL
      ORDER BY added_at ASC
      LIMIT 1`,
  );
  const target = rows[0];
  if (!target) return "empty";
  try {
    await enrichSeedCache(
      BigInt(target.seed),
      target.mc_version,
      target.large_biomes,
    );
    backfillTotalEnriched++;
    logger.debug(
      { seed: target.seed, mc: target.mc_version },
      "backfill: row enriched",
    );
    return "ok";
  } catch (err) {
    logger.warn({ err, seed: target.seed }, "backfill: enrich failed");
    return "failed";
  }
}

export function startBackfillLoop(): void {
  if (!config.backfillEnabled) {
    logger.info("backfill loop disabled");
    return;
  }
  if (!config.enrichLiveResults) {
    /* Without ENRICH_LIVE_RESULTS the seed_enrich binary path may be
     * unset/invalid. Bail out loudly so the operator notices. */
    logger.warn(
      "backfill enabled but ENRICH_LIVE_RESULTS=false — backfill loop will not start",
    );
    return;
  }
  logger.info(
    {
      intervalSec: config.backfillIntervalSec,
      batchSize: config.backfillBatchSize,
    },
    "backfill loop starting",
  );
  const loop = async (): Promise<void> => {
    /* eslint-disable no-constant-condition */
    while (true) {
      for (let i = 0; i < config.backfillBatchSize; i++) {
        try {
          const outcome = await backfillTick();
          if (outcome === "empty") {
            /* Nothing left to enrich — wait a longer pause before
             * re-checking so we don't hammer pg pointlessly. */
            await new Promise<void>((r) =>
              setTimeout(r, config.backfillIntervalSec * 5_000),
            );
            break;
          }
          if (outcome === "skipped") {
            /* Live user is active; give them the slot and try again
             * after the normal interval. */
            break;
          }
        } catch (err) {
          logger.warn({ err }, "backfill tick error");
          break;
        }
      }
      await new Promise<void>((r) =>
        setTimeout(r, config.backfillIntervalSec * 1000),
      );
    }
  };
  /* Stagger start so it doesn't collide with precompute's 15s warm-up. */
  setTimeout(() => void loop(), 25_000);
}
