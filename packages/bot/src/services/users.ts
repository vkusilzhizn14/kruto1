/**
 * User profile + credit management.
 *
 * Credits movements always go through `addCredits` / `spendCredits`, which
 * use an idempotency key to prevent double-application on retries. The
 * `users.balance_credits` column is the materialised running balance and is
 * always edited together with a corresponding `credits_ledger` row inside a
 * single transaction.
 */

import { randomUUID } from "node:crypto";

import { pool } from "./db.js";

export interface UserRow {
  id: number;
  tg_id: number;
  tg_username: string | null;
  tg_first_name: string | null;
  tg_language: string | null;
  balance_credits: number;
  pro_expires_at: Date | null;
  pro_trial_used_at: Date | null;
  free_used_today: number;
  free_used_date: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertUser(input: {
  tgId: number;
  username?: string;
  firstName?: string;
  language?: string;
}): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (tg_id, tg_username, tg_first_name, tg_language)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tg_id) DO UPDATE SET
       tg_username   = COALESCE(EXCLUDED.tg_username,   users.tg_username),
       tg_first_name = COALESCE(EXCLUDED.tg_first_name, users.tg_first_name),
       tg_language   = COALESCE(EXCLUDED.tg_language,   users.tg_language),
       updated_at    = NOW()
     RETURNING *`,
    [input.tgId, input.username ?? null, input.firstName ?? null, input.language ?? null],
  );
  return rows[0]!;
}

export async function getUserByTgId(tgId: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE tg_id = $1", [tgId]);
  return rows[0] ?? null;
}

export interface CreditChangeOptions {
  userId: number;
  delta: number;
  reason: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** Applies a delta to a user's balance idempotently. Returns true if applied. */
export async function changeCredits(opts: CreditChangeOptions): Promise<boolean> {
  const key = opts.idempotencyKey ?? randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM credits_ledger WHERE idempotency_key = $1", [
      key,
    ]);
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE users
          SET balance_credits = balance_credits + $1,
              updated_at = NOW()
        WHERE id = $2`,
      [opts.delta, opts.userId],
    );
    await client.query(
      `INSERT INTO credits_ledger (user_id, delta, reason, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [opts.userId, opts.delta, opts.reason, key, JSON.stringify(opts.metadata ?? {})],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function grantPro(userId: number, days: number): Promise<void> {
  await pool.query(
    `UPDATE users
        SET pro_expires_at = GREATEST(COALESCE(pro_expires_at, NOW()), NOW()) +
                             ($1 || ' days')::interval,
            updated_at = NOW()
      WHERE id = $2`,
    [String(days), userId],
  );
}

export function hasActivePro(user: UserRow): boolean {
  if (!user.pro_expires_at) return false;
  return user.pro_expires_at.getTime() > Date.now();
}

/** Bumps the free counter for today; returns the new counter value. */
export async function bumpFreeUsage(userId: number): Promise<number> {
  const { rows } = await pool.query<{ free_used_today: number }>(
    `UPDATE users
        SET free_used_today = CASE
                                WHEN free_used_date = CURRENT_DATE THEN free_used_today + 1
                                ELSE 1
                              END,
            free_used_date = CURRENT_DATE,
            updated_at = NOW()
      WHERE id = $1
      RETURNING free_used_today`,
    [userId],
  );
  return rows[0]?.free_used_today ?? 0;
}

/**
 * Free daily hits remaining for today.
 *
 * The counter is reset lazily on first use of a new day (via
 * `bumpFreeUsage`'s CASE), so we ask Postgres to apply the same
 * `free_used_date = CURRENT_DATE` reset when reading. This sidesteps any
 * Node/PG timezone mismatch on DATE columns.
 */
export async function freeHitsRemainingForUser(
  userId: number,
  dailyLimit: number,
): Promise<number> {
  const { rows } = await pool.query<{ used: number }>(
    `SELECT CASE WHEN free_used_date = CURRENT_DATE THEN free_used_today ELSE 0 END AS used
       FROM users WHERE id = $1`,
    [userId],
  );
  return Math.max(0, dailyLimit - (rows[0]?.used ?? 0));
}

export interface TrialActivationResult {
  ok: boolean;
  reason?: "already_used" | "already_pro";
  expiresAt?: Date;
}

/**
 * Grants a one-shot 24-hour Pro trial. Returns ok=false if the user has
 * already used the trial or is already on Pro.
 *
 * Uses a single conditional UPDATE so the trial cannot be activated twice
 * even under concurrent presses of the activation button.
 */
export async function activateProTrial(
  userId: number,
  hours: number,
): Promise<TrialActivationResult> {
  const { rows } = await pool.query<{ pro_expires_at: Date }>(
    `UPDATE users
        SET pro_expires_at    = NOW() + ($1 || ' hours')::interval,
            pro_trial_used_at = NOW(),
            updated_at        = NOW()
      WHERE id = $2
        AND pro_trial_used_at IS NULL
        AND (pro_expires_at IS NULL OR pro_expires_at <= NOW())
      RETURNING pro_expires_at`,
    [String(hours), userId],
  );
  if (rows[0]) return { ok: true, expiresAt: rows[0].pro_expires_at };
  /* Find out which precondition failed for a better error message. */
  const u = await pool.query<{ pro_trial_used_at: Date | null; pro_expires_at: Date | null }>(
    "SELECT pro_trial_used_at, pro_expires_at FROM users WHERE id = $1",
    [userId],
  );
  const row = u.rows[0];
  if (row?.pro_expires_at && row.pro_expires_at.getTime() > Date.now()) {
    return { ok: false, reason: "already_pro" };
  }
  return { ok: false, reason: "already_used" };
}
