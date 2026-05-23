/**
 * Per-user rate limit + single-flight guard middleware.
 *
 * Two layers of protection against abuse:
 *
 *   1. Token bucket per Telegram user: hard cap of N actions per minute
 *      (messages or callback queries). Beyond the cap, updates are dropped
 *      silently except for one polite warning reply per window.
 *
 *   2. Single-flight per user for the search wizard: any callback that
 *      starts with `search:run` / `search:next` (i.e. actually spawns the
 *      worker) is rejected while the previous one is still running for the
 *      same user. Prevents a single user from spawning multiple parallel
 *      worker processes by mashing buttons.
 *
 * In-memory state is fine for the single-process MVP. If we ever scale
 * horizontally, this moves to Redis.
 */

import type { Context, MiddlewareFn } from "grammy";

interface Bucket {
  tokens: number;
  refilledAt: number;
  warnedAt: number;
}

const RATE_CAPACITY = 25;          // tokens
const RATE_REFILL_MS = 60_000;     // 25 actions / minute
const WARN_COOLDOWN_MS = 30_000;

const buckets = new Map<number, Bucket>();

function bucketFor(userId: number, now: number): Bucket {
  let b = buckets.get(userId);
  if (!b) {
    b = { tokens: RATE_CAPACITY, refilledAt: now, warnedAt: 0 };
    buckets.set(userId, b);
    return b;
  }
  const elapsed = now - b.refilledAt;
  if (elapsed > 0) {
    const refill = (elapsed / RATE_REFILL_MS) * RATE_CAPACITY;
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + refill);
    b.refilledAt = now;
  }
  return b;
}

export const rateLimit: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return await next();
  const now = Date.now();
  const b = bucketFor(userId, now);
  if (b.tokens < 1) {
    if (now - b.warnedAt > WARN_COOLDOWN_MS) {
      b.warnedAt = now;
      try {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({
            text: "Слишком часто, подожди минутку.",
            show_alert: false,
          });
        } else {
          await ctx.reply("⏱ Слишком часто. Попробуй через минуту.");
        }
      } catch {
        // best effort
      }
    }
    return;
  }
  b.tokens -= 1;
  await next();
};

/* ---------- single-flight (spawning a live worker) ---------- */

const liveLocks = new Set<number>();

export function tryAcquireLive(userId: number): boolean {
  if (liveLocks.has(userId)) return false;
  liveLocks.add(userId);
  return true;
}

export function releaseLive(userId: number): void {
  liveLocks.delete(userId);
}
