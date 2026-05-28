/**
 * Centralised environment-variable configuration.
 *
 * Everything the bot can be tuned with passes through this file. Missing
 * required variables abort the process at startup; optional values have
 * sensible defaults.
 */

import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${v}`);
  return n;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const workerPath = resolve(optional("WORKER_BINARY", "../worker/seed_worker"));
const precomputePath = resolve(optional("PRECOMPUTE_BINARY", "../worker/seed_precompute"));
const enrichPath = resolve(optional("ENRICH_BINARY", "../worker/seed_enrich"));
const migrationsDir = resolve(optional("MIGRATIONS_DIR", "../../db/migrations"));
const stateDir = resolve(optional("STATE_DIR", "/tmp/kruto52-state"));
mkdirSync(stateDir, { recursive: true });

/* Half the available cores per worker, leaving headroom for a parallel
 * second search + Postgres + Node. Override via WORKER_THREADS in .env. */
const defaultWorkerThreads = Math.max(1, Math.floor(availableParallelism() / 2));
/* One live worker per `defaultWorkerThreads`, but at least 1, at most 4 by
 * default. Cache + memo hits bypass the semaphore, so the ceiling only
 * affects the small fraction of requests that fall through to the C worker. */
const defaultLiveConcurrency = Math.max(
  1,
  Math.min(4, Math.floor(availableParallelism() / defaultWorkerThreads)),
);

export const config = {
  // Telegram
  botToken: required("BOT_TOKEN"),
  webhookUrl: process.env.WEBHOOK_URL,
  adminUserIds: (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  proxyUrl: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY,

  // Database
  databaseUrl: required("DATABASE_URL"),
  migrationsDir,

  // Worker
  workerPath,
  precomputePath,
  enrichPath,
  /* Threads per C worker process. 0 = use all cores (legacy behaviour,
   * fine for a single-tenant local dev box, oversubscribes on a shared
   * VPS). Default scales with available parallelism. */
  defaultThreads: optionalNum("WORKER_THREADS", defaultWorkerThreads),
  /* Maximum number of concurrent live C worker processes. Cache and memo
   * hits are free; this ceiling only throttles cache misses to prevent
   * 3+ simultaneous CPU-bound searches from saturating the host. */
  liveSearchConcurrency: optionalNum("LIVE_SEARCH_CONCURRENCY", defaultLiveConcurrency),
  defaultTimeoutMs: optionalNum("SEARCH_TIMEOUT_MS", 30_000),
  /* No hard seed cap by default — `SEARCH_TIMEOUT_MS` alone bounds live
   * searches. Worker iterates with uint64 so this huge default behaves as
   * unlimited (it would take a thousand+ years at 5 M seeds/sec). */
  defaultMaxSeeds: optionalNum("SEARCH_MAX_SEEDS", Number.MAX_SAFE_INTEGER),

  // Payments
  cryptoBotToken: process.env.CRYPTOBOT_TOKEN,
  cryptoBotWebhookSecret: process.env.CRYPTOBOT_WEBHOOK_SECRET,
  cryptoBotApiBase: optional("CRYPTOBOT_API_BASE", "https://pay.crypt.bot/api"),

  // Behaviour
  freeDailyHits: optionalNum("FREE_DAILY_HITS", 2),
  picksPerRow: optionalNum("PICKS_PER_ROW", 2),
  itemsPerPage: optionalNum("ITEMS_PER_PAGE", 8),
  cacheTtlSeconds: optionalNum("QUERY_MEMO_TTL_SEC", 60 * 60 * 24 * 30),

  // Adaptive precompute
  precomputeEnabled: optionalBool("PRECOMPUTE_ENABLED", true),
  precomputeIntervalSec: optionalNum("PRECOMPUTE_INTERVAL_SEC", 600),
  precomputeBatchSize: optionalNum("PRECOMPUTE_BATCH_SIZE", 200),

  // Rare-combo explorer
  explorerEnabled: optionalBool("EXPLORER_ENABLED", true),
  explorerIntervalSec: optionalNum("EXPLORER_INTERVAL_SEC", 60),
  explorerTimeoutMs: optionalNum("EXPLORER_TIMEOUT_MS", 120_000),
  /* Fraction of explorer ticks that pick a combo from `query_demand`
   * top-misses rather than the random rare-combo generator.
   * Range: 0.0–1.0. Default 0.7 = 70% demand-driven, 30% random.
   * 0.0 reverts to legacy pure-random behaviour. */
  explorerDemandRatio: optionalNum("EXPLORER_DEMAND_RATIO", 0.7),

  // Enrich live-search results with full bitmask
  enrichLiveResults: optionalBool("ENRICH_LIVE_RESULTS", true),

  /* Backfill enrichment of historic seed_cache rows. Picks one row per
   * tick whose full bitmask was never computed (enriched_at IS NULL),
   * runs `seed_enrich`, and stamps the result back. Only fires when
   * the live-search semaphore is idle, so it never competes with a
   * real user. */
  backfillEnabled: optionalBool("BACKFILL_ENABLED", true),
  backfillIntervalSec: optionalNum("BACKFILL_INTERVAL_SEC", 30),
  backfillBatchSize: optionalNum("BACKFILL_BATCH_SIZE", 1),

  // Ops
  stateDir,
  logLevel: optional("LOG_LEVEL", "info"),
  /* HTTP health-check endpoint port. Used by Docker healthcheck and
   * external uptime monitors. Set to 0 to disable. */
  healthPort: optionalNum("HEALTH_PORT", 8080),
} as const;
