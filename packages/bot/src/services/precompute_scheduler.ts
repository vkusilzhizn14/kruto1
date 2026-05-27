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
