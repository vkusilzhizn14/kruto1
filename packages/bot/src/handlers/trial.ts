/**
 * 24-hour Pro trial activation.
 *
 * Triggered from the inline button shown when a free user has consumed
 * the daily quota AND has zero credits AND hasn't used the trial before.
 * One-shot: the SQL UPDATE in `activateProTrial` only matches when
 * `pro_trial_used_at IS NULL`, so concurrent presses can never grant a
 * second trial.
 */

import type { CallbackQueryContext, Context } from "grammy";

import { logger } from "../logger.js";
import { activateProTrial, upsertUser } from "../services/users.js";

export const PRO_TRIAL_HOURS = 24;
export const PRO_TRIAL_CALLBACK = "trial:pro:activate";

function formatDateTime(d: Date): string {
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function handleProTrialActivate(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  if (!ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }
  const user = await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  const result = await activateProTrial(user.id, PRO_TRIAL_HOURS);
  if (!result.ok) {
    if (result.reason === "already_pro") {
      await ctx.answerCallbackQuery({
        text: "У тебя уже есть активная Pro подписка.",
        show_alert: true,
      });
    } else {
      await ctx.answerCallbackQuery({
        text: "Бесплатный триал уже был использован. Доступна только покупка.",
        show_alert: true,
      });
    }
    return;
  }
  logger.info(
    { tgId: ctx.from.id, userId: user.id, expiresAt: result.expiresAt },
    "pro trial activated",
  );
  await ctx.answerCallbackQuery({ text: "Pro активирована на 24 часа!" });
  const expiresAt = result.expiresAt!;
  const lines = [
    "🎁 <b>Pro триал активирован на 24 часа</b>",
    "",
    `Безлимитный поиск до: <b>${formatDateTime(expiresAt)}</b>`,
    "",
    "Запускай /search или жми «🔍 Найти сид». После окончания триала Pro можно купить через /buy.",
  ];
  try {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML" });
  } catch {
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }
}
