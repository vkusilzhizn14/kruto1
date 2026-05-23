/**
 * /balance command — surface the user's remaining credits / Pro status so
 * they always know how many live searches they can still spend.
 */

import type { CommandContext, Context } from "grammy";

import { config } from "../config.js";
import { freeHitsRemainingForUser, hasActivePro, upsertUser } from "../services/users.js";

function formatProUntil(date: Date): string {
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export async function handleBalance(ctx: CommandContext<Context> | Context): Promise<void> {
  if (!ctx.from) return;
  const user = await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  const lines = [
    "💎 <b>Твой баланс</b>",
    "",
    `Кредитов: <b>${user.balance_credits}</b>`,
  ];
  if (hasActivePro(user) && user.pro_expires_at) {
    lines.push(`Pro: до <b>${formatProUntil(user.pro_expires_at)}</b> (безлимит)`);
  } else {
    const free = await freeHitsRemainingForUser(user.id, config.freeDailyHits);
    lines.push(`Бесплатных поисков сегодня: <b>${free}</b> из ${config.freeDailyHits}`);
    lines.push("Pro: <i>не активна</i>");
    if (user.pro_trial_used_at === null) {
      lines.push("");
      lines.push("🎁 Доступен <b>бесплатный Pro-триал на 24 часа</b> (один раз на аккаунт).");
    }
  }
  lines.push("");
  lines.push("Каскад: сначала бесплатные хиты, потом кредиты, потом — покупка или Pro.");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
