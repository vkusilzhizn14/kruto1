/**
 * Billing service: Telegram Stars (native) + CryptoBot (USDT/TON).
 *
 * Both flows write to `billing_audit_log` BEFORE any credit movement so that
 * a crash mid-flow leaves a recoverable trail. Successful payments call
 * `applyPaymentSuccess` which:
 *
 *   1. Inserts/updates the audit row with `status='confirmed'`.
 *   2. Calls `changeCredits` with `idempotency_key = providerRef` — this
 *      makes credit application idempotent even if the same webhook arrives
 *      multiple times.
 *   3. For Pro packs, extends `pro_expires_at`.
 *
 * The provider reference (`telegram_payment_charge_id` for Stars; CryptoBot
 * invoice id for CryptoBot) is the idempotency key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { getPack, type PackKind } from "@kruto52/shared";
import { request } from "undici";

import { config } from "../config.js";
import { logger } from "../logger.js";

import { pool } from "./db.js";
import { changeCredits, getUserByTgId, grantPro } from "./users.js";

export interface PaymentRecord {
  userId: number | null;
  method: "tg_stars" | "cryptobot";
  packId: PackKind;
  amountMinor: number;
  currency: string;
  providerRef: string;
  rawPayload: unknown;
}

export async function recordPaymentAttempt(p: PaymentRecord, status: string): Promise<void> {
  await pool.query(
    `INSERT INTO billing_audit_log (
       user_id, method, pack_id, amount_minor, currency,
       provider_ref, status, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (provider_ref) DO UPDATE SET status = EXCLUDED.status`,
    [
      p.userId,
      p.method,
      p.packId,
      p.amountMinor,
      p.currency,
      p.providerRef,
      status,
      JSON.stringify(p.rawPayload ?? null),
    ],
  );
}

export async function applyPaymentSuccess(p: PaymentRecord): Promise<void> {
  await recordPaymentAttempt(p, "confirmed");
  if (p.userId === null) {
    logger.warn({ providerRef: p.providerRef }, "payment confirmed without user_id; skipping credit");
    return;
  }
  const pack = getPack(p.packId);
  if (pack.credits > 0) {
    await changeCredits({
      userId: p.userId,
      delta: pack.credits,
      reason: `purchase:${pack.id}:${p.method}`,
      idempotencyKey: `pay:${p.providerRef}`,
      metadata: { providerRef: p.providerRef, method: p.method, packId: pack.id },
    });
  }
  if (pack.subscriptionDays > 0) {
    await grantPro(p.userId, pack.subscriptionDays);
  }
}

/** Returns the latest pro-active or paying user record for stats. */
export async function getUserByPaymentLookup(tgId: number) {
  return getUserByTgId(tgId);
}

/* ----------------------------------------------------------------- */
/* CryptoBot                                                           */
/* ----------------------------------------------------------------- */

export interface CryptoBotInvoice {
  invoiceId: string;
  payUrl: string;
}

export async function createCryptoBotInvoice(input: {
  packId: PackKind;
  userId: number;
  asset: "USDT" | "TON";
}): Promise<CryptoBotInvoice | null> {
  if (!config.cryptoBotToken) return null;
  const pack = getPack(input.packId);
  const res = await request(`${config.cryptoBotApiBase}/createInvoice`, {
    method: "POST",
    headers: {
      "Crypto-Pay-API-Token": config.cryptoBotToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(pack.usdtPrice),
      currency_type: "crypto",
      asset: input.asset,
      description: `kruto52: ${pack.nameRu}`,
      payload: JSON.stringify({ userId: input.userId, packId: input.packId }),
      allow_anonymous: false,
    }),
  });
  if (res.statusCode >= 400) {
    logger.warn({ statusCode: res.statusCode }, "cryptobot createInvoice failed");
    return null;
  }
  const body = (await res.body.json()) as { ok: boolean; result?: { invoice_id: number; pay_url: string } };
  if (!body.ok || !body.result) return null;
  return { invoiceId: String(body.result.invoice_id), payUrl: body.result.pay_url };
}

/** Verifies the CryptoBot webhook signature header per their docs. */
export function verifyCryptoBotSignature(rawBody: string, signature: string): boolean {
  if (!config.cryptoBotToken) return false;
  const secretKey = createHmac("sha256", "WebhookSignatureSecret")
    .update(config.cryptoBotToken)
    .digest();
  const expected = createHmac("sha256", secretKey).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
