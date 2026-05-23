/**
 * Admin commands — only Telegram IDs listed in `ADMIN_USER_IDS` can use
 * these. Every command runs through the same flow:
 *
 *   1. Reject non-admin senders with a short message.
 *   2. Parse the argument list — first token resolves to a user
 *      (numeric `tg_id` or `@username`; reply-to also supported), the
 *      rest are command-specific (amount, days, etc).
 *   3. Apply the change via `services/admin.ts`, which is responsible
 *      for journaling everything in `credits_ledger`.
 *   4. Reply to the admin with the new state.
 *
 * Argument parsing is intentionally permissive: whitespace, `+` / `-`
 * prefixes and the words `all` / `forever` are accepted where natural.
 */

import type { CommandContext, Context } from "grammy";

import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  adminAdjustCredits,
  adminAdjustPro,
  adminRevokePro,
  adminSetCredits,
  adminUserProfile,
  parseUserRef,
  resolveUser,
} from "../services/admin.js";
import { hasActivePro, upsertUser, type UserRow } from "../services/users.js";

function isAdmin(ctx: Context): boolean {
  return !!ctx.from && config.adminUserIds.includes(ctx.from.id);
}

function commandArgs(ctx: CommandContext<Context>): string[] {
  const text = ctx.message?.text ?? "";
  return text
    .split(/\s+/)
    .slice(1)
    .filter((s) => s.length > 0);
}

function parseDays(token: string): number | null {
  const m = /^([+-]?\d+)\s*(d|day|days|m|mo|month|months|y|yr|year|years)?$/i.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "d").toLowerCase();
  if (unit.startsWith("y")) return n * 365;
  if (unit.startsWith("mo") || unit === "m") return n * 30;
  return n;
}

function parseAmount(token: string): number | null {
  const m = /^([+-]?\d+)$/.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

function formatExpiry(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function userLabel(u: UserRow): string {
  const name = u.tg_first_name ?? "—";
  const handle = u.tg_username ? `@${u.tg_username}` : `id:${u.tg_id}`;
  return `${name} (${handle})`;
}

/**
 * Resolve the user the admin is acting on. If the admin replied to a
 * Telegram message we take that user; otherwise we expect the first
 * positional argument to be a tg_id or `@username`.
 */
async function resolveTarget(
  ctx: CommandContext<Context>,
  ref: string | undefined,
): Promise<UserRow | { error: string }> {
  const replyTo = ctx.message?.reply_to_message?.from;
  if (replyTo && !ref) {
    const user = await upsertUser({
      tgId: replyTo.id,
      username: replyTo.username,
      firstName: replyTo.first_name,
      language: replyTo.language_code,
    });
    return user;
  }
  if (!ref) return { error: "Укажи пользователя: tg_id или @username, либо ответь на его сообщение." };
  const parsed = parseUserRef(ref);
  if (!parsed) return { error: `Не могу разобрать пользователя: <code>${ref}</code>` };
  const u = await resolveUser(parsed);
  if (!u) {
    if (parsed.kind === "username") {
      return { error: `Пользователь @${parsed.value} ещё не запускал бота. Используй его tg_id.` };
    }
    return { error: "Пользователь не найден." };
  }
  return u;
}

async function denyIfNotAdmin(ctx: Context): Promise<boolean> {
  if (isAdmin(ctx)) return false;
  await ctx.reply("Команда только для админов.");
  return true;
}

/* ------------------------------------------------------------------ */
/* /admin — short help                                                 */
/* ------------------------------------------------------------------ */

export async function handleAdminHelp(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const lines = [
    "🛠 <b>Админ-команды</b>",
    "",
    "<b>Кредиты</b>",
    "<code>/grant_credits &lt;user&gt; &lt;N&gt;</code> — выдать N кредитов",
    "<code>/revoke_credits &lt;user&gt; &lt;N|all&gt;</code> — забрать N кредитов (или все)",
    "<code>/set_credits &lt;user&gt; &lt;N&gt;</code> — установить точное значение",
    "",
    "<b>Pro подписка</b>",
    "<code>/grant_pro &lt;user&gt; &lt;N[d|mo|y]&gt;</code> — продлить Pro на N дней/мес/лет",
    "<code>/revoke_pro &lt;user&gt;</code> — снять Pro немедленно",
    "",
    "<b>Прочее</b>",
    "<code>/whois &lt;user&gt;</code> — карточка пользователя",
    "",
    "<b>Способы указать пользователя</b>",
    "• tg_id: <code>7076147624</code>",
    "• username: <code>@venop1</code>",
    "• ответом на любое сообщение пользователя",
    "",
    "Примеры:",
    "<code>/grant_credits @venop1 50</code>",
    "<code>/grant_pro 7076147624 30d</code>",
    "<code>/revoke_credits @venop1 all</code>",
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/* ------------------------------------------------------------------ */
/* Credit commands                                                     */
/* ------------------------------------------------------------------ */

export async function handleGrantCredits(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const args = commandArgs(ctx);
  const [refArg, amountArg] = ctx.message?.reply_to_message
    ? [undefined, args[0]]
    : [args[0], args[1]];
  const target = await resolveTarget(ctx, refArg);
  if ("error" in target) {
    await ctx.reply(target.error, { parse_mode: "HTML" });
    return;
  }
  if (!amountArg) {
    await ctx.reply("Укажи количество кредитов: <code>/grant_credits &lt;user&gt; &lt;N&gt;</code>", {
      parse_mode: "HTML",
    });
    return;
  }
  const n = parseAmount(amountArg);
  if (n === null || n <= 0) {
    await ctx.reply("Количество должно быть положительным целым числом.");
    return;
  }
  const adminTgId = ctx.from!.id;
  const result = await adminAdjustCredits({
    adminTgId,
    user: target,
    delta: n,
    reason: "admin_grant",
  });
  logger.info(
    { admin: adminTgId, target: target.tg_id, delta: result.applied, balance: result.newBalance },
    "admin grant credits",
  );
  await ctx.reply(
    `✅ <b>+${result.applied}</b> кредитов выдано пользователю ${userLabel(target)}.\n` +
      `Новый баланс: <b>${result.newBalance}</b>`,
    { parse_mode: "HTML" },
  );
}

export async function handleRevokeCredits(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const args = commandArgs(ctx);
  const [refArg, amountArg] = ctx.message?.reply_to_message
    ? [undefined, args[0]]
    : [args[0], args[1]];
  const target = await resolveTarget(ctx, refArg);
  if ("error" in target) {
    await ctx.reply(target.error, { parse_mode: "HTML" });
    return;
  }
  if (!amountArg) {
    await ctx.reply("Укажи количество: <code>/revoke_credits &lt;user&gt; &lt;N|all&gt;</code>", {
      parse_mode: "HTML",
    });
    return;
  }
  let n: number;
  if (/^all$/i.test(amountArg)) {
    n = target.balance_credits;
    if (n === 0) {
      await ctx.reply(`У ${userLabel(target)} и так 0 кредитов.`, { parse_mode: "HTML" });
      return;
    }
  } else {
    const parsed = parseAmount(amountArg);
    if (parsed === null || parsed <= 0) {
      await ctx.reply("Количество должно быть положительным целым числом или <code>all</code>.", {
        parse_mode: "HTML",
      });
      return;
    }
    n = parsed;
  }
  const adminTgId = ctx.from!.id;
  const result = await adminAdjustCredits({
    adminTgId,
    user: target,
    delta: -n,
    reason: "admin_revoke",
  });
  logger.info(
    { admin: adminTgId, target: target.tg_id, delta: result.applied, balance: result.newBalance, clamped: result.clamped },
    "admin revoke credits",
  );
  const clampNote = result.clamped ? " (заявка обрезана до текущего баланса)" : "";
  await ctx.reply(
    `✅ <b>${result.applied}</b> кредитов снято у ${userLabel(target)}${clampNote}.\n` +
      `Новый баланс: <b>${result.newBalance}</b>`,
    { parse_mode: "HTML" },
  );
}

export async function handleSetCredits(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const args = commandArgs(ctx);
  const [refArg, amountArg] = ctx.message?.reply_to_message
    ? [undefined, args[0]]
    : [args[0], args[1]];
  const target = await resolveTarget(ctx, refArg);
  if ("error" in target) {
    await ctx.reply(target.error, { parse_mode: "HTML" });
    return;
  }
  if (!amountArg) {
    await ctx.reply("Укажи новое значение баланса: <code>/set_credits &lt;user&gt; &lt;N&gt;</code>", {
      parse_mode: "HTML",
    });
    return;
  }
  const n = parseAmount(amountArg);
  if (n === null || n < 0) {
    await ctx.reply("Значение должно быть неотрицательным целым числом.");
    return;
  }
  const adminTgId = ctx.from!.id;
  const result = await adminSetCredits({
    adminTgId,
    user: target,
    value: n,
    reason: "admin_set",
  });
  logger.info(
    { admin: adminTgId, target: target.tg_id, delta: result.applied, balance: result.newBalance },
    "admin set credits",
  );
  await ctx.reply(
    `✅ Баланс ${userLabel(target)} установлен в <b>${result.newBalance}</b>\n` +
      `(дельта <b>${result.applied >= 0 ? "+" : ""}${result.applied}</b>)`,
    { parse_mode: "HTML" },
  );
}

/* ------------------------------------------------------------------ */
/* Pro commands                                                        */
/* ------------------------------------------------------------------ */

export async function handleGrantPro(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const args = commandArgs(ctx);
  const [refArg, daysArg] = ctx.message?.reply_to_message
    ? [undefined, args[0]]
    : [args[0], args[1]];
  const target = await resolveTarget(ctx, refArg);
  if ("error" in target) {
    await ctx.reply(target.error, { parse_mode: "HTML" });
    return;
  }
  if (!daysArg) {
    await ctx.reply(
      "Укажи срок: <code>/grant_pro &lt;user&gt; &lt;N[d|mo|y]&gt;</code>. Примеры: <code>30</code>, <code>3mo</code>, <code>1y</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }
  const days = parseDays(daysArg);
  if (days === null || days === 0) {
    await ctx.reply("Срок должен быть ненулевым целым числом дней/мес/лет.");
    return;
  }
  if (days < 0) {
    await ctx.reply("Для уменьшения Pro используй <code>/grant_pro</code> с отрицательным числом или <code>/revoke_pro</code>.", {
      parse_mode: "HTML",
    });
  }
  const adminTgId = ctx.from!.id;
  const newExpiry = await adminAdjustPro({ user: target, days });
  logger.info(
    { admin: adminTgId, target: target.tg_id, days, expires_at: newExpiry?.toISOString() ?? null },
    "admin adjust pro",
  );
  const sign = days > 0 ? "+" : "";
  await ctx.reply(
    `✅ Pro для ${userLabel(target)} изменён на <b>${sign}${days}</b> дней.\n` +
      `Действует до: <b>${formatExpiry(newExpiry)}</b>`,
    { parse_mode: "HTML" },
  );
}

export async function handleRevokePro(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const args = commandArgs(ctx);
  const refArg = ctx.message?.reply_to_message ? undefined : args[0];
  const target = await resolveTarget(ctx, refArg);
  if ("error" in target) {
    await ctx.reply(target.error, { parse_mode: "HTML" });
    return;
  }
  const adminTgId = ctx.from!.id;
  await adminRevokePro(target.id);
  logger.info({ admin: adminTgId, target: target.tg_id }, "admin revoke pro");
  await ctx.reply(`✅ Pro у ${userLabel(target)} снят.`, { parse_mode: "HTML" });
}

/* ------------------------------------------------------------------ */
/* /whois                                                              */
/* ------------------------------------------------------------------ */

export async function handleWhois(ctx: CommandContext<Context>): Promise<void> {
  if (await denyIfNotAdmin(ctx)) return;
  const args = commandArgs(ctx);
  const refArg = ctx.message?.reply_to_message ? undefined : args[0];
  const target = await resolveTarget(ctx, refArg);
  if ("error" in target) {
    await ctx.reply(target.error, { parse_mode: "HTML" });
    return;
  }
  const profile = await adminUserProfile(target.id);
  if (!profile) {
    await ctx.reply("Профиль не найден.");
    return;
  }
  const { user, totalCreditsGranted, totalCreditsSpent, totalPaidMinor, searches7d, searchesTotal } = profile;
  const lines = [
    `👤 <b>${userLabel(user)}</b>`,
    `tg_id: <code>${user.tg_id}</code>`,
    `Зарегистрирован: ${user.created_at.toISOString().slice(0, 19).replace("T", " ")} UTC`,
    "",
    `Баланс: <b>${user.balance_credits}</b> кредитов`,
    `Pro: ${hasActivePro(user) ? `активна до <b>${formatExpiry(user.pro_expires_at)}</b>` : "<i>не активна</i>"}`,
    `Выдано всего: <b>+${totalCreditsGranted}</b>`,
    `Потрачено всего: <b>-${totalCreditsSpent}</b>`,
    `Оплачено (минор-юниты): <b>${totalPaidMinor}</b>`,
    `Поисков за 7 дней: <b>${searches7d}</b> / всего: <b>${searchesTotal}</b>`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
