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
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

export class Semaphore {
  private inFlightCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(public readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer (got ${limit})`);
    }
  }

  /** Acquire a slot. Resolves immediately if a slot is free, otherwise queues. */
  async acquire(): Promise<void> {
    if (this.inFlightCount < this.limit) {
      this.inFlightCount++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    /* Slot was handed off from `release()` — inFlightCount already counts us. */
  }

  /** Release a slot. Wakes the next waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      /* Hand the slot over directly — inFlightCount stays at `limit`. */
      next();
    } else {
      this.inFlightCount--;
    }
  }

  /** Run `fn` under the semaphore, releasing on success or failure. */
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
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
}

export const liveSearchSemaphore = new Semaphore(config.liveSearchConcurrency);

logger.info(
  { limit: liveSearchSemaphore.limit },
  "live search semaphore configured",
);
