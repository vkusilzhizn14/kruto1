/**
 * /buy — package selection and Telegram Stars invoicing.
 *
 * Stars are invoiced via `sendInvoice` with `currency='XTR'` and an empty
 * provider_token. The Bot API takes care of the rest.
 *
 * On `pre_checkout_query` we answer `ok=true` (no client-side cap to enforce
 * other than what we can recover from). On `successful_payment` we resolve
 * the package id from the invoice payload and call `applyPaymentSuccess`.
 */

import { PACKS, type PackKind, getPack } from "@kruto52/shared";
import type {
  CallbackQueryContext,
  CommandContext,
  Context,
  HearsContext,
  Filter,
} from "grammy";

import { logger } from "../logger.js";
import { buyKeyboard } from "../keyboards/main.js";
import {
  applyPaymentSuccess,
  createCryptoBotInvoice,
  recordPaymentAttempt,
} from "../services/billing.js";
import { upsertUser } from "../services/users.js";

const STARS_CURRENCY = "XTR";

export async function handleBuyCommand(
  ctx: CommandContext<Context> | HearsContext<Context> | Context,
): Promise<void> {
  const lines: string[] = ["💎 Выбери пак — оплата через Telegram Stars:"];
  for (const p of PACKS) {
    lines.push("", `<b>${p.nameRu}</b> — ${p.stars}⭐️ — ${p.descRu}`);
  }
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: buyKeyboard(),
  });
}

export async function handleBuyCallback(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  const data = ctx.callbackQuery.data ?? "";
  if (!ctx.from || !ctx.chat) return;

  if (data === "buy:open") {
    await ctx.answerCallbackQuery();
    await handleBuyCommand(ctx);
    return;
  }

  if (data.startsWith("buy:pack:")) {
    const packId = data.slice("buy:pack:".length) as PackKind;
    const pack = getPack(packId);
    await ctx.answerCallbackQuery();
    const payload = JSON.stringify({ kind: "stars", packId, tg: ctx.from.id });
    await ctx.api.sendInvoice(
      ctx.chat.id,
      pack.nameRu,
      pack.descRu,
      payload,
      STARS_CURRENCY,
      [{ label: pack.nameRu, amount: pack.stars }],
    );
    return;
  }

  if (data === "buy:crypto:menu") {
    await ctx.answerCallbackQuery();
    const lines = ["Выбери криптовалюту:"];
    await ctx.reply(lines.join("\n"));
    return;
  }

  if (data.startsWith("buy:crypto:")) {
    const [, , packId, asset] = data.split(":") as [string, string, PackKind, "USDT" | "TON"];
    await ctx.answerCallbackQuery();
    const user = await upsertUser({
      tgId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      language: ctx.from.language_code,
    });
    const invoice = await createCryptoBotInvoice({ packId, userId: user.id, asset });
    if (!invoice) {
      await ctx.reply("CryptoBot временно недоступен, попробуй Stars.");
      return;
    }
    await ctx.reply(`Открой ссылку для оплаты ${asset}:\n${invoice.payUrl}`);
  }
}

export async function handlePreCheckout(
  ctx: Filter<Context, "pre_checkout_query">,
): Promise<void> {
  await ctx.answerPreCheckoutQuery(true);
}

export async function handleSuccessfulPayment(
  ctx: Filter<Context, "message:successful_payment">,
): Promise<void> {
  const pay = ctx.message.successful_payment;
  if (!ctx.from) return;
  let parsed: { kind: string; packId: PackKind; tg: number } | null = null;
  try {
    parsed = JSON.parse(pay.invoice_payload) as { kind: string; packId: PackKind; tg: number };
  } catch (err) {
    logger.error({ err, payload: pay.invoice_payload }, "successful_payment: bad payload");
    return;
  }
  const user = await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  try {
    await recordPaymentAttempt(
      {
        userId: user.id,
        method: "tg_stars",
        packId: parsed.packId,
        amountMinor: pay.total_amount,
        currency: pay.currency,
        providerRef: pay.telegram_payment_charge_id,
        rawPayload: pay,
      },
      "received",
    );
    await applyPaymentSuccess({
      userId: user.id,
      method: "tg_stars",
      packId: parsed.packId,
      amountMinor: pay.total_amount,
      currency: pay.currency,
      providerRef: pay.telegram_payment_charge_id,
      rawPayload: pay,
    });
    const pack = getPack(parsed.packId);
    const msg = pack.subscriptionDays > 0
      ? `✅ Pro подписка активирована на ${pack.subscriptionDays} дней!`
      : `✅ Зачислено ${pack.credits} кредитов. Спасибо!`;
    await ctx.reply(msg);
  } catch (err) {
    logger.error({ err }, "applyPaymentSuccess failed");
    await ctx.reply("Платёж получен, но при зачислении произошёл сбой. Напиши владельцу — поправим.");
  }
}
