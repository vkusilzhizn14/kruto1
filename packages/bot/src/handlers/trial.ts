/**
 * 24-hour Pro trial — ВЫПИЛЕН (п.9, 2026-05-28).
 *
 * Файл оставлен, потому что:
 *   • PRO_TRIAL_CALLBACK всё ещё может прилететь от старых inline-кнопок
 *     в существующих чатах. Без хэндлера они бы молчали (плохой UX).
 *   • Импорт PRO_TRIAL_CALLBACK всё ещё используется в index.ts для
 *     регистрации хэндлера-заглушки.
 *
 * Если когда-нибудь решим вернуть триал — здесь нужно восстановить
 * прошлую логику из git history (последний рабочий коммит до этого).
 *
 * Поле users.pro_trial_used_at оставлено в схеме нетронутым — данные
 * прошлых триалов не теряем.
 */

import type { CallbackQueryContext, Context } from "grammy";

export const PRO_TRIAL_CALLBACK = "trial:pro:activate";

export async function handleProTrialActivate(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  await ctx.answerCallbackQuery({
    text: "Бесплатный триал больше не доступен. Открой /buy — там пробный пак за 30⭐.",
    show_alert: true,
  });
}
