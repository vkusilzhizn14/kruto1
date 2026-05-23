/**
 * Admin operations — manual credit adjustments and Pro grants/revokes.
 *
 * Every credit movement still goes through `credits_ledger` with an
 * idempotency key so the audit trail mirrors the regular billing flow.
 * Pro changes are logged via the structured logger; we don't keep a
 * separate `pro_audit_log` table to avoid a migration round-trip.
 *
 * `balance_credits` has a `CHECK (balance_credits >= 0)` constraint, so
 * any debit that would push the balance negative is clamped to the
 * current balance and the actual applied delta is returned.
 */

import { randomUUID } from "node:crypto";

import { pool } from "./db.js";
import { upsertUser, type UserRow } from "./users.js";

export type UserRef =
  | { kind: "tg_id"; value: number }
  | { kind: "username"; value: string };

/**
 * Parse a user reference from a CLI-style token. Accepts:
 *   • plain numeric ids: `7076147624`
 *   • Telegram usernames with or without leading `@`: `@venop1`, `venop1`
 */
export function parseUserRef(token: string): UserRef | null {
  const cleaned = token.trim().replace(/^@/, "");
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) {
    const n = Number(cleaned);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return { kind: "tg_id", value: n };
  }
  if (/^[A-Za-z0-9_]{3,32}$/.test(cleaned)) {
    return { kind: "username", value: cleaned };
  }
  return null;
}

/**
 * Resolve a `UserRef` to a row. For numeric tg_id refs we upsert a stub
 * row (so admins can grant credits to users who haven't `/start`-ed the
 * bot yet); for `@username` refs we only return users already known.
 */
export async function resolveUser(ref: UserRef): Promise<UserRow | null> {
  if (ref.kind === "tg_id") {
    return upsertUser({ tgId: ref.value });
  }
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users WHERE LOWER(tg_username) = LOWER($1) LIMIT 1",
    [ref.value],
  );
  return rows[0] ?? null;
}

export interface AdjustCreditsResult {
  applied: number;
  newBalance: number;
  clamped: boolean;
}

/**
 * Adjust a user's balance by `delta`. Negative deltas that would push
 * the balance below zero are clamped to `-currentBalance` (the CHECK
 * constraint would otherwise abort the transaction). Returns the
 * actually applied delta and the new balance.
 */
export async function adminAdjustCredits(opts: {
  adminTgId: number;
  user: UserRow;
  delta: number;
  reason: string;
}): Promise<AdjustCreditsResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ balance_credits: number }>(
      "SELECT balance_credits FROM users WHERE id = $1 FOR UPDATE",
      [opts.user.id],
    );
    const balance = rows[0]?.balance_credits ?? 0;
    let applied = opts.delta;
    let clamped = false;
    if (applied < 0 && -applied > balance) {
      applied = -balance;
      clamped = true;
    }
    if (applied === 0) {
      await client.query("ROLLBACK");
      return { applied: 0, newBalance: balance, clamped };
    }
    const idempotencyKey = `admin:${opts.adminTgId}:${randomUUID()}`;
    await client.query(
      `UPDATE users
          SET balance_credits = balance_credits + $1,
              updated_at = NOW()
        WHERE id = $2`,
      [applied, opts.user.id],
    );
    await client.query(
      `INSERT INTO credits_ledger (user_id, delta, reason, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        opts.user.id,
        applied,
        opts.reason,
        idempotencyKey,
        JSON.stringify({ admin_tg_id: opts.adminTgId, target_tg_id: opts.user.tg_id }),
      ],
    );
    await client.query("COMMIT");
    return { applied, newBalance: balance + applied, clamped };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Set a user's balance to exactly `value`. Implemented as a single
 * delta computed against the current balance so the ledger still
 * tells a coherent story.
 */
export async function adminSetCredits(opts: {
  adminTgId: number;
  user: UserRow;
  value: number;
  reason: string;
}): Promise<AdjustCreditsResult> {
  if (opts.value < 0) {
    throw new Error("balance value must be non-negative");
  }
  const { rows } = await pool.query<{ balance_credits: number }>(
    "SELECT balance_credits FROM users WHERE id = $1",
    [opts.user.id],
  );
  const balance = rows[0]?.balance_credits ?? 0;
  const delta = opts.value - balance;
  return adminAdjustCredits({
    adminTgId: opts.adminTgId,
    user: opts.user,
    delta,
    reason: opts.reason,
  });
}

/**
 * Extend or shrink a user's Pro expiry by `days`.
 *   • positive days extend from MAX(now, current_expiry)
 *   • negative days subtract from current expiry (NULL if it goes past now)
 * Returns the resulting expiry timestamp.
 */
export async function adminAdjustPro(opts: {
  user: UserRow;
  days: number;
}): Promise<Date | null> {
  if (opts.days === 0) {
    return opts.user.pro_expires_at;
  }
  if (opts.days > 0) {
    await pool.query(
      `UPDATE users
          SET pro_expires_at = GREATEST(COALESCE(pro_expires_at, NOW()), NOW())
                             + ($1 || ' days')::interval,
              updated_at = NOW()
        WHERE id = $2`,
      [String(opts.days), opts.user.id],
    );
  } else {
    await pool.query(
      `UPDATE users
          SET pro_expires_at = CASE
              WHEN pro_expires_at IS NULL THEN NULL
              WHEN pro_expires_at - ($1 || ' days')::interval <= NOW() THEN NULL
              ELSE pro_expires_at - ($1 || ' days')::interval
            END,
              updated_at = NOW()
        WHERE id = $2`,
      [String(Math.abs(opts.days)), opts.user.id],
    );
  }
  const { rows } = await pool.query<{ pro_expires_at: Date | null }>(
    "SELECT pro_expires_at FROM users WHERE id = $1",
    [opts.user.id],
  );
  return rows[0]?.pro_expires_at ?? null;
}

/** Immediately clear a user's Pro subscription. */
export async function adminRevokePro(userId: number): Promise<void> {
  await pool.query(
    "UPDATE users SET pro_expires_at = NULL, updated_at = NOW() WHERE id = $1",
    [userId],
  );
}

/**
 * Aggregate user profile for the `/whois` admin command. We hit a few
 * tables once and surface what an operator typically wants: identity,
 * balance, Pro state, lifetime spend and recent search count.
 */
export async function adminUserProfile(userId: number): Promise<{
  user: UserRow;
  totalCreditsGranted: number;
  totalCreditsSpent: number;
  totalPaidMinor: number;
  searches7d: number;
  searchesTotal: number;
} | null> {
  const user = (
    await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId])
  ).rows[0];
  if (!user) return null;
  const ledger = (
    await pool.query<{ granted: string | null; spent: string | null }>(
      `SELECT COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0)::text AS granted,
              COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0)::text AS spent
         FROM credits_ledger WHERE user_id = $1`,
      [userId],
    )
  ).rows[0];
  const paid = (
    await pool.query<{ s: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS s
         FROM billing_audit_log
        WHERE user_id = $1 AND status = 'confirmed'`,
      [userId],
    )
  ).rows[0];
  const recent = (
    await pool.query<{ d7: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - interval '7 days')::text AS d7,
              COUNT(*)::text                                                       AS total
         FROM search_history WHERE user_id = $1`,
      [userId],
    )
  ).rows[0];
  return {
    user,
    totalCreditsGranted: Number(ledger?.granted ?? 0),
    totalCreditsSpent: Number(ledger?.spent ?? 0),
    totalPaidMinor: Number(paid?.s ?? 0),
    searches7d: Number(recent?.d7 ?? 0),
    searchesTotal: Number(recent?.total ?? 0),
  };
}
