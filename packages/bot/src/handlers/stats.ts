/**
 * /stats — owner-only dashboard. Counts daily active users, revenue and
 * top-demanded queries to know what to precompute next.
 */

import type { CommandContext, Context } from "grammy";

import { config } from "../config.js";
import { pool } from "../services/db.js";

export async function handleStats(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  if (!config.adminUserIds.includes(ctx.from.id)) {
    await ctx.reply("Команда только для админов.");
    return;
  }
  const dau = await pool.query<{ c: string }>(
    `SELECT COUNT(DISTINCT user_id)::text AS c
       FROM search_history
      WHERE created_at > NOW() - interval '24 hours'`,
  );
  const newUsers = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM users WHERE created_at > NOW() - interval '24 hours'`,
  );
  const revenue = await pool.query<{ s: string | null }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS s
       FROM billing_audit_log
      WHERE status = 'confirmed' AND created_at > NOW() - interval '24 hours'`,
  );
  const conv = await pool.query<{ buyers: string; users_total: string }>(
    `SELECT (SELECT COUNT(DISTINCT user_id)::text FROM billing_audit_log WHERE status='confirmed') AS buyers,
            (SELECT COUNT(*)::text FROM users) AS users_total`,
  );
  const top = await pool.query<{ request_count: number; cache_misses: number; mc_version: string; radius: number }>(
    `SELECT request_count, cache_misses, mc_version, radius
       FROM query_demand
      ORDER BY request_count DESC
      LIMIT 5`,
  );

  const lines = [
    "📊 Stats — последние 24 часа",
    `DAU (искали): ${dau.rows[0]?.c ?? 0}`,
    `Новых юзеров: ${newUsers.rows[0]?.c ?? 0}`,
    `Выручка Stars (за 24ч, минор-юниты): ${revenue.rows[0]?.s ?? "0"}`,
    `Платящие: ${conv.rows[0]?.buyers ?? 0} из ${conv.rows[0]?.users_total ?? 0}`,
    "",
    "🔥 Топ-5 запросов:",
    ...top.rows.map(
      (r) => `· R${r.radius} MC${r.mc_version}: ${r.request_count} запросов, ${r.cache_misses} промахов`,
    ),
  ];
  await ctx.reply(lines.join("\n"));
}
