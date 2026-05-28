/**
 * Per-search performance metrics — single point of entry for recording
 * how each find-seed call performed (which layer answered it, how long
 * it took, how many seeds were tested). Aggregations live in
 * `handlers/stats.ts`.
 *
 * Writes are async and best-effort: a metrics insert failure must never
 * block or fail a user-facing search. We log and swallow.
 */

import { logger } from "../logger.js";

import { pool } from "./db.js";

export type MetricSource = "memo" | "cache" | "live" | "not_found" | "cancelled";

export interface RecordMetricInput {
  userId?: number | null;
  queryHash: string;
  source: MetricSource;
  elapsedMs: number;
  seedsTested?: number | bigint;
  found: boolean;
  radius: number;
  mcVersion: string;
  isBackground?: boolean;
}

export async function recordSearchMetric(input: RecordMetricInput): Promise<void> {
  try {
    const tested =
      typeof input.seedsTested === "bigint"
        ? input.seedsTested
        : BigInt(Math.max(0, Math.floor(input.seedsTested ?? 0)));
    await pool.query(
      `INSERT INTO live_search_metrics
         (user_id, query_hash, source, elapsed_ms, seeds_tested,
          found, radius, mc_version, is_background)
       VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9)`,
      [
        input.userId ?? null,
        input.queryHash.slice(0, 64),
        input.source,
        Math.max(0, Math.round(input.elapsedMs)),
        tested.toString(),
        input.found,
        input.radius,
        input.mcVersion,
        input.isBackground ?? false,
      ],
    );
  } catch (err) {
    /* Never propagate metric errors — they are observability, not
     * critical path. */
    logger.warn({ err }, "recordSearchMetric failed");
  }
}

export interface MetricsWindowSummary {
  total: number;
  memoCount: number;
  cacheCount: number;
  liveCount: number;
  notFoundCount: number;
  cancelledCount: number;
  liveAvgMs: number;
  liveP50Ms: number;
  liveP95Ms: number;
  liveAvgSeedsPerSec: number;
  liveAvgSeedsTested: number;
}

/**
 * Aggregate metrics for a single time window. Foreground (non-background)
 * traffic only — background jobs are not what we want to expose as
 * "how the bot is performing for users".
 */
export async function summarizeWindow(opts: {
  since: Date;
  until?: Date;
}): Promise<MetricsWindowSummary> {
  const until = opts.until ?? new Date();
  const { rows } = await pool.query<{
    total: string;
    memo_count: string;
    cache_count: string;
    live_count: string;
    not_found_count: string;
    cancelled_count: string;
    live_avg_ms: string | null;
    live_p50_ms: string | null;
    live_p95_ms: string | null;
    live_avg_seeds: string | null;
    live_avg_sps: string | null;
  }>(
    `SELECT
        COUNT(*)::text                                                AS total,
        COUNT(*) FILTER (WHERE source = 'memo')::text                 AS memo_count,
        COUNT(*) FILTER (WHERE source = 'cache')::text                AS cache_count,
        COUNT(*) FILTER (WHERE source = 'live')::text                 AS live_count,
        COUNT(*) FILTER (WHERE source = 'not_found')::text            AS not_found_count,
        COUNT(*) FILTER (WHERE source = 'cancelled')::text            AS cancelled_count,
        AVG(elapsed_ms)
          FILTER (WHERE source = 'live')::text                        AS live_avg_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY elapsed_ms)
          FILTER (WHERE source = 'live')::text                        AS live_p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY elapsed_ms)
          FILTER (WHERE source = 'live')::text                        AS live_p95_ms,
        AVG(seeds_tested)
          FILTER (WHERE source = 'live' AND seeds_tested > 0)::text   AS live_avg_seeds,
        AVG(
          CASE WHEN source = 'live' AND elapsed_ms > 0
               THEN (seeds_tested::numeric * 1000) / elapsed_ms
          END
        )::text                                                       AS live_avg_sps
       FROM live_search_metrics
      WHERE is_background = false
        AND created_at >= $1
        AND created_at <  $2`,
    [opts.since, until],
  );
  const r = rows[0]!;
  const num = (s: string | null | undefined): number =>
    s === null || s === undefined ? 0 : Number(s);
  return {
    total: Number(r.total),
    memoCount: Number(r.memo_count),
    cacheCount: Number(r.cache_count),
    liveCount: Number(r.live_count),
    notFoundCount: Number(r.not_found_count),
    cancelledCount: Number(r.cancelled_count),
    liveAvgMs: Math.round(num(r.live_avg_ms)),
    liveP50Ms: Math.round(num(r.live_p50_ms)),
    liveP95Ms: Math.round(num(r.live_p95_ms)),
    liveAvgSeedsTested: Math.round(num(r.live_avg_seeds)),
    liveAvgSeedsPerSec: Math.round(num(r.live_avg_sps)),
  };
}

export interface BackgroundSummary {
  explorerFound: number;
  backfillEnriched: number;
}

export async function summarizeBackground(opts: {
  since: Date;
  until?: Date;
}): Promise<BackgroundSummary> {
  const until = opts.until ?? new Date();
  /* Explorer rows are tagged is_background=true AND user_id IS NULL.
   * We count `live`+`found=true` as "new seed discovered by explorer".
   * Backfill enrichments are reflected via seed_cache.source='enriched'
   * row counts (queried separately by handler). */
  const { rows } = await pool.query<{ explorer_found: string }>(
    `SELECT COUNT(*)::text AS explorer_found
       FROM live_search_metrics
      WHERE is_background = true
        AND source = 'live'
        AND found = true
        AND created_at >= $1
        AND created_at <  $2`,
    [opts.since, until],
  );
  return {
    explorerFound: Number(rows[0]?.explorer_found ?? 0),
    backfillEnriched: 0, // populated by handler from seed_cache
  };
}

export interface TopMissedCombo {
  queryHash: string;
  mcVersion: string;
  radius: number;
  requestCount: number;
  cacheMisses: number;
}

/**
 * Top combinations that users have asked for but were not found in cache
 * — the next thing the demand-driven explorer should chew on.
 */
export async function topMissedCombos(limit = 5): Promise<TopMissedCombo[]> {
  const { rows } = await pool.query<{
    query_hash: string;
    mc_version: string;
    radius: number;
    request_count: number;
    cache_misses: number;
  }>(
    `SELECT query_hash, mc_version, radius, request_count, cache_misses
       FROM query_demand
      WHERE cache_misses > 0
      ORDER BY cache_misses DESC, request_count DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    queryHash: r.query_hash,
    mcVersion: r.mc_version,
    radius: r.radius,
    requestCount: r.request_count,
    cacheMisses: r.cache_misses,
  }));
}

export interface SeedCacheBreakdown {
  precompute: number;
  live: number;
  enriched: number;
  total: number;
}

export async function seedCacheBreakdown(): Promise<SeedCacheBreakdown> {
  const { rows } = await pool.query<{ source: string; n: string }>(
    `SELECT source, COUNT(*)::text AS n FROM seed_cache GROUP BY source`,
  );
  const out: SeedCacheBreakdown = { precompute: 0, live: 0, enriched: 0, total: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    out.total += n;
    if (r.source === "precompute") out.precompute = n;
    else if (r.source === "live") out.live = n;
    else if (r.source === "enriched") out.enriched = n;
  }
  return out;
}
