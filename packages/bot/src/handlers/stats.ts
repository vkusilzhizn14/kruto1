/**
 * /stats and /stats_compare — owner-only dashboard.
 *
 * /stats         shows the current snapshot of activity, cache health,
 *                live-search performance and background-parser output for
 *                the last 24 hours.
 * /stats_compare reports the deltas between two windows so the operator
 *                can see whether a recent change (env tweak, native
 *                build, demand-driven explorer, etc.) actually moved the
 *                numbers. Defaults to comparing today (last 24h) against
 *                the previous 24h block.
 *
 * Both commands only read — no side effects, no migrations triggered
 * here. The underlying time-series data is captured by
 * `services/metrics.ts`.
 */

import type { CommandContext, Context } from "grammy";

import { config } from "../config.js";
import { pool } from "../services/db.js";
import {
  seedCacheBreakdown,
  summarizeBackground,
  summarizeWindow,
  topMissedCombos,
  type MetricsWindowSummary,
} from "../services/metrics.js";

interface ActivityRow {
  dau: number;
  newUsers: number;
  revenueMinor: number;
  buyers: number;
  usersTotal: number;
}

async function activitySnapshot(since: Date): Promise<ActivityRow> {
  const [dau, newUsers, revenue, conv] = await Promise.all([
    pool.query<{ c: string }>(
      `SELECT COUNT(DISTINCT user_id)::text AS c
         FROM search_history
        WHERE created_at >= $1`,
      [since],
    ),
    pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users WHERE created_at >= $1`,
      [since],
    ),
    pool.query<{ s: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS s
         FROM billing_audit_log
        WHERE status = 'confirmed' AND created_at >= $1`,
      [since],
    ),
    pool.query<{ buyers: string; users_total: string }>(
      `SELECT (SELECT COUNT(DISTINCT user_id)::text FROM billing_audit_log WHERE status='confirmed') AS buyers,
              (SELECT COUNT(*)::text FROM users) AS users_total`,
    ),
  ]);
  return {
    dau: Number(dau.rows[0]?.c ?? 0),
    newUsers: Number(newUsers.rows[0]?.c ?? 0),
    revenueMinor: Number(revenue.rows[0]?.s ?? "0"),
    buyers: Number(conv.rows[0]?.buyers ?? 0),
    usersTotal: Number(conv.rows[0]?.users_total ?? 0),
  };
}

function pct(num: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.round((num * 100) / denom);
}

function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent * width) / 100)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}мс`;
  return `${(ms / 1000).toFixed(1)}с`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("ru-RU");
}

function fmtDelta(now: number, prev: number, opts?: { lowerIsBetter?: boolean }): string {
  const lowerIsBetter = opts?.lowerIsBetter === true;
  if (prev === 0 && now === 0) return "—";
  if (prev === 0) return "(новое)";
  const delta = now - prev;
  const pctDelta = Math.round((delta * 100) / Math.max(1, Math.abs(prev)));
  const sign = delta >= 0 ? "+" : "";
  const good = lowerIsBetter ? delta < 0 : delta > 0;
  const arrow = delta === 0 ? "→" : good ? "▲" : "▼";
  return `${sign}${pctDelta}% ${arrow}`;
}

function renderSnapshot(args: {
  windowLabel: string;
  activity: ActivityRow;
  metrics: MetricsWindowSummary;
  background: { explorerFound: number; backfillEnriched: number };
  seedCache: { precompute: number; live: number; enriched: number; total: number };
  topMissed: ReadonlyArray<{
    queryHash: string;
    mcVersion: string;
    radius: number;
    requestCount: number;
    cacheMisses: number;
  }>;
}): string {
  const { metrics, activity, background, seedCache, topMissed, windowLabel } = args;
  const memoPct = pct(metrics.memoCount, metrics.total);
  const cachePct = pct(metrics.cacheCount, metrics.total);
  const livePct = pct(metrics.liveCount, metrics.total);
  const hitRate = memoPct + cachePct;
  const notFoundPct = pct(metrics.notFoundCount, metrics.total);

  const lines: string[] = [];
  lines.push(`📊 <b>Stats — ${windowLabel}</b>`);
  lines.push("");

  lines.push("<b>Активность</b>");
  lines.push(
    `DAU: ${activity.dau} · новых: ${activity.newUsers} · ⭐ выручка: ${fmtNum(activity.revenueMinor)}`,
  );
  lines.push(`Покупатели: ${activity.buyers} из ${activity.usersTotal} юзеров`);
  lines.push("");

  lines.push("<b>Кеш и слой ответа</b>");
  if (metrics.total === 0) {
    lines.push("За окно не было запросов от юзеров.");
  } else {
    lines.push(`Запросов: <b>${fmtNum(metrics.total)}</b>`);
    lines.push(`memo:  ${memoPct.toString().padStart(2, " ")}%  ${bar(memoPct)}`);
    lines.push(`cache: ${cachePct.toString().padStart(2, " ")}%  ${bar(cachePct)}`);
    lines.push(`live:  ${livePct.toString().padStart(2, " ")}%  ${bar(livePct)}`);
    if (metrics.notFoundCount > 0) lines.push(`not_found: ${notFoundPct}% (${metrics.notFoundCount})`);
    lines.push(`Hit rate: <b>${hitRate}%</b> (цель 90%+)`);
  }
  lines.push("");

  lines.push("<b>Живой поиск</b>");
  if (metrics.liveCount === 0) {
    lines.push("Не было live-вызовов за окно (всё из кеша).");
  } else {
    lines.push(
      `Avg: ${fmtMs(metrics.liveAvgMs)} · p50: ${fmtMs(metrics.liveP50Ms)} · p95: ${fmtMs(metrics.liveP95Ms)}`,
    );
    if (metrics.liveAvgSeedsPerSec > 0) {
      lines.push(`Скорость: <b>${fmtNum(metrics.liveAvgSeedsPerSec)}</b> сид/с`);
    }
    if (metrics.liveAvgSeedsTested > 0) {
      lines.push(`Avg сидов на запрос: ${fmtNum(metrics.liveAvgSeedsTested)}`);
    }
  }
  lines.push("");

  lines.push("<b>Пассивный парсинг</b>");
  lines.push(`Кеш сидов: ${seedCache.total} (precompute: ${seedCache.precompute}, live: ${seedCache.live}, enriched: ${seedCache.enriched})`);
  lines.push(`Explorer нашёл за окно: ${background.explorerFound}`);
  lines.push(`Backfill обогатил за окно: ${background.backfillEnriched}`);
  lines.push("");

  if (topMissed.length > 0) {
    lines.push("<b>Топ-5 промахов</b> (для explorer'а)");
    for (const r of topMissed) {
      lines.push(
        `· R${r.radius} MC${r.mcVersion} — ${r.cacheMisses} промах(ов) / ${r.requestCount} запросов`,
      );
    }
  }

  return lines.join("\n");
}

function isAdmin(ctx: CommandContext<Context>): boolean {
  return ctx.from !== undefined && config.adminUserIds.includes(ctx.from.id);
}

async function fetchSnapshot(args: { since: Date; until?: Date }): Promise<{
  activity: ActivityRow;
  metrics: MetricsWindowSummary;
  background: { explorerFound: number; backfillEnriched: number };
  seedCache: { precompute: number; live: number; enriched: number; total: number };
  topMissed: ReadonlyArray<{
    queryHash: string;
    mcVersion: string;
    radius: number;
    requestCount: number;
    cacheMisses: number;
  }>;
}> {
  const [activity, metrics, background, seedCache, topMissed, enrichedInWindow] = await Promise.all([
    activitySnapshot(args.since),
    summarizeWindow({ since: args.since, until: args.until }),
    summarizeBackground({ since: args.since, until: args.until }),
    seedCacheBreakdown(),
    topMissedCombos(5),
    /* Backfill rows are seed_cache entries with source='enriched' whose
     * `enriched_at` falls inside the window. `enriched_at` is stamped
     * by `upsertSeedCacheFull` whenever the row was (re)enriched. Rows
     * enriched before migration 004 have NULL here and are not
     * counted; the count starts fresh from the migration day. */
    pool
      .query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM seed_cache
          WHERE source = 'enriched'
            AND enriched_at IS NOT NULL
            AND enriched_at >= $1
            AND enriched_at <  $2`,
        [args.since, args.until ?? new Date()],
      )
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0),
  ]);
  return {
    activity,
    metrics,
    background: { ...background, backfillEnriched: enrichedInWindow },
    seedCache,
    topMissed,
  };
}

export async function handleStats(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  if (!isAdmin(ctx)) {
    await ctx.reply("Команда только для админов.");
    return;
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const snap = await fetchSnapshot({ since });
  const text = renderSnapshot({ windowLabel: "последние 24ч", ...snap });
  await ctx.reply(text, { parse_mode: "HTML" });
}

function fmtCount(now: number, prev: number, opts?: { lowerIsBetter?: boolean }): string {
  return `${fmtNum(now)} ← ${fmtNum(prev)}  ${fmtDelta(now, prev, opts)}`;
}

function fmtPctVal(now: number, prev: number, opts?: { lowerIsBetter?: boolean }): string {
  return `${now}% ← ${prev}%  ${fmtDelta(now, prev, opts)}`;
}

function fmtMsCmp(now: number, prev: number): string {
  return `${fmtMs(now)} ← ${fmtMs(prev)}  ${fmtDelta(now, prev, { lowerIsBetter: true })}`;
}

export async function handleStatsCompare(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  if (!isAdmin(ctx)) {
    await ctx.reply("Команда только для админов.");
    return;
  }
  const now = new Date();
  const dayMs = 24 * 3600 * 1000;
  const sinceCurrent = new Date(now.getTime() - dayMs);
  const sincePrev = new Date(now.getTime() - 2 * dayMs);
  const untilPrev = sinceCurrent;

  const [cur, prev] = await Promise.all([
    fetchSnapshot({ since: sinceCurrent }),
    fetchSnapshot({ since: sincePrev, until: untilPrev }),
  ]);

  const curHit = pct(cur.metrics.memoCount + cur.metrics.cacheCount, cur.metrics.total);
  const prevHit = pct(prev.metrics.memoCount + prev.metrics.cacheCount, prev.metrics.total);

  const lines: string[] = [];
  lines.push("📈 <b>Сравнение: сегодня vs вчера</b>");
  lines.push("Формат: <code>сейчас ← раньше   дельта</code>");
  lines.push("");

  lines.push("<b>Объём</b>");
  lines.push(`Запросов:  ${fmtCount(cur.metrics.total, prev.metrics.total)}`);
  lines.push(`DAU:       ${fmtCount(cur.activity.dau, prev.activity.dau)}`);
  lines.push("");

  lines.push("<b>Кеш</b>");
  lines.push(`Hit rate:  ${fmtPctVal(curHit, prevHit)}`);
  lines.push(
    `memo:      ${fmtPctVal(pct(cur.metrics.memoCount, cur.metrics.total), pct(prev.metrics.memoCount, prev.metrics.total))}`,
  );
  lines.push(
    `cache:     ${fmtPctVal(pct(cur.metrics.cacheCount, cur.metrics.total), pct(prev.metrics.cacheCount, prev.metrics.total))}`,
  );
  lines.push(
    `live:      ${fmtPctVal(pct(cur.metrics.liveCount, cur.metrics.total), pct(prev.metrics.liveCount, prev.metrics.total), { lowerIsBetter: true })}`,
  );
  lines.push("");

  lines.push("<b>Скорость live-поиска</b>");
  lines.push(`Avg:       ${fmtMsCmp(cur.metrics.liveAvgMs, prev.metrics.liveAvgMs)}`);
  lines.push(`p50:       ${fmtMsCmp(cur.metrics.liveP50Ms, prev.metrics.liveP50Ms)}`);
  lines.push(`p95:       ${fmtMsCmp(cur.metrics.liveP95Ms, prev.metrics.liveP95Ms)}`);
  if (cur.metrics.liveAvgSeedsPerSec > 0 || prev.metrics.liveAvgSeedsPerSec > 0) {
    lines.push(
      `сид/с:     ${fmtCount(cur.metrics.liveAvgSeedsPerSec, prev.metrics.liveAvgSeedsPerSec)}`,
    );
  }
  lines.push("");

  lines.push("<b>Пассивный парсинг</b>");
  lines.push(`Explorer:  ${fmtCount(cur.background.explorerFound, prev.background.explorerFound)}`);
  lines.push(
    `Backfill:  ${fmtCount(cur.background.backfillEnriched, prev.background.backfillEnriched)}`,
  );
  lines.push(`Сидов всего в кеше сейчас: <b>${fmtNum(cur.seedCache.total)}</b>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
