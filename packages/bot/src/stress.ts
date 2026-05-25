/**
 * Stress-test harness. Runs entirely inside the bot process — same DB
 * pool, same `findSeed`, same `liveSearchSemaphore`. Does NOT go
 * through Telegram so we can drive arbitrary concurrency without
 * worrying about rate limits or fake users.
 *
 * Usage:
 *   node dist/stress.js <test_name>
 *
 * Tests:
 *   baseline                — idle metrics + DB connectivity sanity
 *   cache-storm             — 100 sequential cache-only lookups
 *   cache-storm-parallel    — 100 parallel cache-only lookups
 *   live-queue              — 5 parallel cache-miss searches → queue
 *   cancel-queued           — start 3 searches, cancel 2 while queued
 *   cancel-running          — start a long search, cancel mid-flight
 *   mixed                   — interleaved cache + live + cancel
 *   soak                    — 5-minute mixed workload, watch RSS
 *   pool-saturation         — 50 parallel raw DB queries
 *   all                     — runs all of the above in order
 *
 * Each test prints a JSON summary on the last line so the wrapper
 * script can grep / parse results.
 */

import { performance } from "node:perf_hooks";

import { getRadius } from "@kruto52/shared";

import { logger } from "./logger.js";
import { liveSearchSemaphore } from "./services/concurrency.js";
import { pool } from "./services/db.js";
import { findSeed, type SearchInput } from "./services/search.js";

/* ---------- helpers ---------- */

interface CallStats {
  count: number;
  ok: number;
  cancelled: number;
  notFound: number;
  errors: number;
  latenciesMs: number[];
  sources: Record<string, number>;
}

function newStats(): CallStats {
  return {
    count: 0,
    ok: 0,
    cancelled: 0,
    notFound: 0,
    errors: 0,
    latenciesMs: [],
    sources: {},
  };
}

function p(stats: CallStats, q: number): number {
  if (stats.latenciesMs.length === 0) return 0;
  const sorted = [...stats.latenciesMs].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(q * sorted.length),
  );
  return Math.round(sorted[idx]!);
}

function summarize(label: string, stats: CallStats): Record<string, unknown> {
  return {
    label,
    count: stats.count,
    ok: stats.ok,
    cancelled: stats.cancelled,
    notFound: stats.notFound,
    errors: stats.errors,
    latency_ms: {
      p50: p(stats, 0.5),
      p95: p(stats, 0.95),
      p99: p(stats, 0.99),
      max: stats.latenciesMs.length ? Math.round(Math.max(...stats.latenciesMs)) : 0,
    },
    sources: stats.sources,
  };
}

/* ---------- workload primitives ---------- */

/* Common filters used across tests. The cache-friendly ones should
 * almost always hit (precompute has fed enough seeds). The miss
 * variants pile up combinations precompute is unlikely to have
 * generated yet. */
const FILTER_CACHE_HIT_VARIANTS: Array<{ biomes: string[]; structures: string[] }> = [
  { biomes: ["plains", "forest"], structures: ["village"] },
  { biomes: ["desert", "river"], structures: ["village"] },
  { biomes: ["forest"], structures: ["village", "ruined_portal"] },
  { biomes: ["plains"], structures: [] },
  { biomes: ["river"], structures: ["shipwreck"] },
];

/* Designed to almost-certainly miss cache: rare biomes + structures
 * combos precompute is unlikely to enumerate at small radii. */
const FILTER_CACHE_MISS_VARIANTS: Array<{ biomes: string[]; structures: string[] }> = [
  { biomes: ["dark_forest"], structures: ["desert_pyramid", "jungle_temple"] },
  { biomes: ["mushroom_fields"], structures: ["village"] },
  { biomes: ["jungle"], structures: ["ocean_monument"] },
  { biomes: ["flower_forest"], structures: ["desert_pyramid"] },
  { biomes: ["birch_forest"], structures: ["pillager_outpost", "swamp_hut"] },
];

const TEST_USER_ID = -999999; // sentinel: never collides with real users

function makeInput(
  filter: { biomes: string[]; structures: string[] },
  opts: { cacheOnly?: boolean; cancelSignal?: AbortSignal; timeoutMs?: number } = {},
): SearchInput {
  return {
    userId: TEST_USER_ID,
    mc: "1.21",
    largeBiomes: false,
    radius: getRadius("200"),
    biomeIds: filter.biomes,
    structureIds: filter.structures,
    allowLiveSearch: !opts.cacheOnly,
    cancelSignal: opts.cancelSignal,
    timeoutMs: opts.timeoutMs ?? 15_000,
  };
}

async function callAndRecord(stats: CallStats, input: SearchInput): Promise<void> {
  stats.count++;
  const t0 = performance.now();
  try {
    const r = await findSeed(input);
    const dt = performance.now() - t0;
    stats.latenciesMs.push(dt);
    if (r.ok) {
      stats.ok++;
      stats.sources[r.outcome.source] = (stats.sources[r.outcome.source] ?? 0) + 1;
    } else if (r.reason === "cancelled") {
      stats.cancelled++;
    } else if (r.reason === "not_found") {
      stats.notFound++;
    } else {
      stats.errors++;
    }
  } catch (err) {
    stats.errors++;
    const dt = performance.now() - t0;
    stats.latenciesMs.push(dt);
    logger.error({ err }, "stress call threw");
  }
}

async function dbStats(): Promise<{ totalCount: number; idleCount: number; waitingCount: number }> {
  /* pg.Pool exposes totalCount/idleCount/waitingCount on the instance. */
  type PoolInternals = { totalCount: number; idleCount: number; waitingCount: number };
  const p = pool as unknown as PoolInternals;
  return {
    totalCount: p.totalCount,
    idleCount: p.idleCount,
    waitingCount: p.waitingCount,
  };
}

async function rssMb(): Promise<number> {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- tests ---------- */

async function testBaseline(): Promise<Record<string, unknown>> {
  const db = await dbStats();
  /* simple SELECT 1 to confirm DB lives. */
  const t0 = performance.now();
  await pool.query("SELECT 1");
  const dbLatencyMs = Math.round(performance.now() - t0);
  return {
    test: "baseline",
    db,
    db_latency_ms: dbLatencyMs,
    semaphore: { in_flight: liveSearchSemaphore.inFlight, queued: liveSearchSemaphore.queued, limit: liveSearchSemaphore.limit },
    rss_mb: await rssMb(),
  };
}

async function testCacheStormSequential(): Promise<Record<string, unknown>> {
  const stats = newStats();
  for (let i = 0; i < 100; i++) {
    const filter = FILTER_CACHE_HIT_VARIANTS[i % FILTER_CACHE_HIT_VARIANTS.length]!;
    await callAndRecord(stats, makeInput(filter, { cacheOnly: true }));
  }
  return { test: "cache-storm-sequential", rss_mb: await rssMb(), db: await dbStats(), ...summarize("cache-storm-sequential", stats) };
}

async function testCacheStormParallel(): Promise<Record<string, unknown>> {
  const stats = newStats();
  await Promise.all(
    Array.from({ length: 100 }, (_, i) => {
      const filter = FILTER_CACHE_HIT_VARIANTS[i % FILTER_CACHE_HIT_VARIANTS.length]!;
      return callAndRecord(stats, makeInput(filter, { cacheOnly: true }));
    }),
  );
  return { test: "cache-storm-parallel", rss_mb: await rssMb(), db: await dbStats(), ...summarize("cache-storm-parallel", stats) };
}

async function testLiveQueue(): Promise<Record<string, unknown>> {
  const stats = newStats();
  /* Snapshot semaphore depth while requests are in flight. */
  let peakQueued = 0;
  let peakInFlight = 0;
  const monitor = setInterval(() => {
    peakQueued = Math.max(peakQueued, liveSearchSemaphore.queued);
    peakInFlight = Math.max(peakInFlight, liveSearchSemaphore.inFlight);
  }, 50);
  try {
    await Promise.all(
      FILTER_CACHE_MISS_VARIANTS.map((f) =>
        callAndRecord(stats, makeInput(f, { timeoutMs: 8_000 })),
      ),
    );
  } finally {
    clearInterval(monitor);
  }
  return {
    test: "live-queue",
    peak_in_flight: peakInFlight,
    peak_queued: peakQueued,
    rss_mb: await rssMb(),
    db: await dbStats(),
    ...summarize("live-queue", stats),
  };
}

async function testCancelQueued(): Promise<Record<string, unknown>> {
  const stats = newStats();
  /* Fire 3 searches; cancel the 2nd and 3rd ~100ms in (still queued
   * given LIVE_SEARCH_CONCURRENCY=1). */
  const acs: AbortController[] = [];
  const calls = FILTER_CACHE_MISS_VARIANTS.slice(0, 3).map((f) => {
    const ac = new AbortController();
    acs.push(ac);
    return callAndRecord(stats, makeInput(f, { cancelSignal: ac.signal, timeoutMs: 8_000 }));
  });
  await sleep(200);
  acs[1]!.abort();
  acs[2]!.abort();
  await Promise.all(calls);
  return {
    test: "cancel-queued",
    cancellations_attempted: 2,
    rss_mb: await rssMb(),
    db: await dbStats(),
    ...summarize("cancel-queued", stats),
  };
}

async function testCancelRunning(): Promise<Record<string, unknown>> {
  const stats = newStats();
  /* Fire one long search, cancel after 1s (definitely past acquire). */
  const ac = new AbortController();
  const call = callAndRecord(
    stats,
    makeInput(FILTER_CACHE_MISS_VARIANTS[0]!, {
      cancelSignal: ac.signal,
      timeoutMs: 30_000,
    }),
  );
  await sleep(1500);
  const inFlightBefore = liveSearchSemaphore.inFlight;
  ac.abort();
  /* Wait briefly for slot release. */
  await call;
  const inFlightAfter = liveSearchSemaphore.inFlight;
  return {
    test: "cancel-running",
    semaphore_in_flight_before_abort: inFlightBefore,
    semaphore_in_flight_after_abort: inFlightAfter,
    rss_mb: await rssMb(),
    db: await dbStats(),
    ...summarize("cancel-running", stats),
  };
}

async function testMixed(): Promise<Record<string, unknown>> {
  const stats = newStats();
  /* 10 cache hits + 3 live + 1 cancel-queued, all racing. */
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    const f = FILTER_CACHE_HIT_VARIANTS[i % FILTER_CACHE_HIT_VARIANTS.length]!;
    tasks.push(callAndRecord(stats, makeInput(f, { cacheOnly: true })));
  }
  for (let i = 0; i < 3; i++) {
    const f = FILTER_CACHE_MISS_VARIANTS[i]!;
    tasks.push(callAndRecord(stats, makeInput(f, { timeoutMs: 8_000 })));
  }
  /* one cancelled. */
  const ac = new AbortController();
  tasks.push(
    callAndRecord(
      stats,
      makeInput(FILTER_CACHE_MISS_VARIANTS[3]!, {
        cancelSignal: ac.signal,
        timeoutMs: 8_000,
      }),
    ),
  );
  setTimeout(() => ac.abort(), 250);
  await Promise.all(tasks);
  return {
    test: "mixed",
    rss_mb: await rssMb(),
    db: await dbStats(),
    ...summarize("mixed", stats),
  };
}

async function testSoak(): Promise<Record<string, unknown>> {
  const stats = newStats();
  const rssSamples: number[] = [];
  const startRss = await rssMb();
  rssSamples.push(startRss);
  const monitor = setInterval(async () => {
    rssSamples.push(await rssMb());
  }, 5_000);
  const start = Date.now();
  const durationMs = 5 * 60 * 1000;
  try {
    while (Date.now() - start < durationMs) {
      /* Mix of cache hits + live attempts. Don't await sequentially
       * to keep some parallelism. */
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 3; i++) {
        const f = FILTER_CACHE_HIT_VARIANTS[Math.floor(Math.random() * FILTER_CACHE_HIT_VARIANTS.length)]!;
        tasks.push(callAndRecord(stats, makeInput(f, { cacheOnly: true })));
      }
      if (Math.random() < 0.3) {
        const f = FILTER_CACHE_MISS_VARIANTS[Math.floor(Math.random() * FILTER_CACHE_MISS_VARIANTS.length)]!;
        tasks.push(callAndRecord(stats, makeInput(f, { timeoutMs: 8_000 })));
      }
      await Promise.all(tasks);
      await sleep(250);
    }
  } finally {
    clearInterval(monitor);
  }
  const endRss = await rssMb();
  rssSamples.push(endRss);
  return {
    test: "soak",
    duration_sec: Math.round((Date.now() - start) / 1000),
    rss_start_mb: startRss,
    rss_end_mb: endRss,
    rss_max_mb: Math.max(...rssSamples),
    rss_min_mb: Math.min(...rssSamples),
    rss_growth_mb: endRss - startRss,
    db: await dbStats(),
    ...summarize("soak", stats),
  };
}

async function testPoolSaturation(): Promise<Record<string, unknown>> {
  /* Run 50 SELECTs in parallel — the pool default is 10, so most
   * will queue. We measure whether all complete without ECONNREFUSED
   * or "connection terminated" errors. */
  const tasks: Promise<unknown>[] = [];
  const errors: string[] = [];
  const start = performance.now();
  for (let i = 0; i < 50; i++) {
    tasks.push(
      pool.query("SELECT pg_sleep(0.1), $1::int as i", [i]).catch((err: Error) => {
        errors.push(err.message);
      }),
    );
  }
  await Promise.all(tasks);
  const dt = performance.now() - start;
  return {
    test: "pool-saturation",
    queries: 50,
    duration_ms: Math.round(dt),
    errors: errors.length,
    error_samples: errors.slice(0, 3),
    db: await dbStats(),
    rss_mb: await rssMb(),
  };
}

/* ---------- runner ---------- */

const tests: Record<string, () => Promise<Record<string, unknown>>> = {
  baseline: testBaseline,
  "cache-storm": testCacheStormSequential,
  "cache-storm-parallel": testCacheStormParallel,
  "live-queue": testLiveQueue,
  "cancel-queued": testCancelQueued,
  "cancel-running": testCancelRunning,
  mixed: testMixed,
  soak: testSoak,
  "pool-saturation": testPoolSaturation,
};

async function main(): Promise<void> {
  const name = process.argv[2] ?? "baseline";
  if (name === "all") {
    const results: Record<string, unknown>[] = [];
    for (const [n, fn] of Object.entries(tests)) {
      if (n === "soak") continue; // run soak separately; long.
      logger.info({ test: n }, "running stress test");
      const result = await fn();
      results.push(result);
      logger.info({ result }, "test result");
    }
    console.log(JSON.stringify({ batch: "all", results }, null, 2));
  } else {
    const fn = tests[name];
    if (!fn) {
      logger.error({ name, available: Object.keys(tests) }, "unknown test");
      process.exit(2);
    }
    logger.info({ test: name }, "running stress test");
    const result = await fn();
    console.log(JSON.stringify(result, null, 2));
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "stress harness fatal");
  process.exit(1);
});
