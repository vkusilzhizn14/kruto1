/**
 * Centralised environment-variable configuration.
 *
 * Everything the bot can be tuned with passes through this file. Missing
 * required variables abort the process at startup; optional values have
 * sensible defaults.
 */

import { mkdirSync } from "node:fs";
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
const migrationsDir = resolve(optional("MIGRATIONS_DIR", "../../db/migrations"));
const stateDir = resolve(optional("STATE_DIR", "/tmp/kruto52-state"));
mkdirSync(stateDir, { recursive: true });

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
  defaultThreads: optionalNum("WORKER_THREADS", 0), // 0 = all cores
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

  // Ops
  stateDir,
  logLevel: optional("LOG_LEVEL", "info"),
} as const;
