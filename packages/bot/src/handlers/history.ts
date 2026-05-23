/**
 * /history — last 10 searches with seed copy buttons.
 */

import type { CommandContext, Context, HearsContext } from "grammy";

import { pool } from "../services/db.js";
import { upsertUser } from "../services/users.js";

export async function handleHistory(
  ctx: CommandContext<Context> | HearsContext<Context>,
): Promise<void> {
  if (!ctx.from) return;
  const user = await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  const { rows } = await pool.query<{
    mc_version: string;
    radius: number;
    result_seed: string | null;
    created_at: Date;
    source: string;
  }>(
    `SELECT mc_version, radius, result_seed::text, created_at, source
       FROM search_history
      WHERE user_id = $1
   ORDER BY created_at DESC
      LIMIT 10`,
    [user.id],
  );
  if (rows.length === 0) {
    await ctx.reply("История пуста. Сделай первый поиск!");
    return;
  }
  const lines: string[] = ["📜 Последние 10 поисков:", ""];
  for (const r of rows) {
    const seed = r.result_seed ?? "—";
    const when = new Date(r.created_at).toLocaleString("ru-RU");
    lines.push(`• ${when} · MC ${r.mc_version} · R${r.radius} · сид: <code>${seed}</code> (${r.source})`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
