/**
 * Concurrency primitives for the bot.
 *
 * The live C worker is CPU-bound (cubiomes climate noise + structure
 * verification). Letting an unbounded number of worker processes run in
 * parallel oversubscribes the host's cores and degrades every search.
 *
 * `liveSearchSemaphore` enforces a small concurrent ceiling: requests
 * beyond the ceiling wait in a FIFO queue. Cache and memo hits do not
 * pass through here — only live worker spawns do.
 *
 * Waiters can be observed (queue position is reported through callbacks
 * so the bot can keep the user informed) and aborted (cancel button in
 * the live-search UI removes the waiter from the queue without spawning
 * a worker).
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

export interface AcquireOptions {
  /**
   * Called once when the request is enqueued (slot was not immediately
   * available). `position` is 1-based — `1` means "next to acquire".
   * Not called if a slot was free at acquire time.
   */
  onQueued?: (position: number) => void;
  /**
   * Called whenever this waiter's queue position improves (someone ahead
   * finished and released their slot). The final call before the slot is
   * granted will have `position=0` — followed by the acquire promise
   * resolving. Not called after the promise has resolved.
   */
  onPositionChanged?: (position: number) => void;
  /**
   * If set and the signal aborts before the slot is granted, the waiter
   * is removed from the queue and `acquire()` rejects with the signal's
   * reason (defaults to a DOMException 'AbortError').
   */
  signal?: AbortSignal;
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  onPositionChanged?: (position: number) => void;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

export class Semaphore {
  private inFlightCount = 0;
  private readonly waiters: Waiter[] = [];

  constructor(public readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer (got ${limit})`);
    }
  }

  /** Acquire a slot. Resolves immediately if a slot is free, otherwise queues. */
  async acquire(opts?: AcquireOptions): Promise<void> {
    if (this.inFlightCount < this.limit) {
      this.inFlightCount++;
      return;
    }
    if (opts?.signal?.aborted) {
      throw opts.signal.reason ?? new Error("aborted");
    }

    const waiter: Waiter = {
      // placeholders, overwritten before the Promise body runs
      resolve: () => undefined,
      reject: () => undefined,
      onPositionChanged: opts?.onPositionChanged,
      signal: opts?.signal,
    };

    const promise = new Promise<void>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });

    this.waiters.push(waiter);
    /* Tell the caller their initial queue position. Position is 1-based
     * (1 = next to be granted) so users see "1 in queue" not "0". */
    const initialPosition = this.waiters.length;
    if (opts?.onQueued) {
      try {
        opts.onQueued(initialPosition);
      } catch (err) {
        logger.debug({ err }, "onQueued callback threw");
      }
    }

    if (opts?.signal) {
      waiter.abortHandler = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx === -1) return; // already granted/dropped
        this.waiters.splice(idx, 1);
        this.notifyPositions();
        waiter.reject(opts.signal!.reason ?? new Error("aborted"));
      };
      opts.signal.addEventListener("abort", waiter.abortHandler, { once: true });
    }

    try {
      await promise;
    } finally {
      if (waiter.signal && waiter.abortHandler) {
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
      }
    }
  }

  /** Release a slot. Wakes the next waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      /* Hand the slot over directly — inFlightCount stays at `limit`. */
      try {
        next.onPositionChanged?.(0);
      } catch (err) {
        logger.debug({ err }, "onPositionChanged final callback threw");
      }
      next.resolve();
      this.notifyPositions();
    } else {
      this.inFlightCount--;
    }
  }

  /**
   * Run `fn` under the semaphore, releasing on success or failure.
   * Pass an `AbortSignal` via `opts.signal` to be able to bail out while
   * still queued; once the slot is granted, the abort no longer takes
   * effect from inside `withSlot` — the caller is responsible for
   * cancelling whatever work `fn` is doing.
   */
  async withSlot<T>(fn: () => Promise<T>, opts?: AcquireOptions): Promise<T> {
    await this.acquire(opts);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Notify each remaining waiter of their (1-based) position. */
  private notifyPositions(): void {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (!w.onPositionChanged) continue;
      try {
        w.onPositionChanged(i + 1);
      } catch (err) {
        logger.debug({ err }, "onPositionChanged callback threw");
      }
    }
  }
}

export const liveSearchSemaphore = new Semaphore(config.liveSearchConcurrency);

logger.info(
  { limit: liveSearchSemaphore.limit },
  "live search semaphore configured",
);
