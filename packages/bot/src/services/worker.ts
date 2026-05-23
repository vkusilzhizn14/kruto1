/**
 * Wrapper around the C seed worker process.
 *
 * The worker is invoked as a child process per search request. We stream a
 * single JSON line on stdin and consume `\n`-delimited JSON lines on stdout.
 * Cancellation is achieved by sending SIGTERM — the worker catches it and
 * emits a `cancelled` line before exiting.
 *
 * One-shot per request keeps things simple and isolates memory; cubiomes
 * `Generator` setup is fast (sub-millisecond) compared to even a single
 * cache miss search, so we don't yet need a long-lived worker pool.
 */

import { spawn } from "node:child_process";

import type {
  CancelledMessage,
  ErrorMessage,
  NotFoundMessage,
  ProgressMessage,
  ResultMessage,
  WorkerMessage,
  WorkerSearchRequest,
} from "@kruto52/shared";

import { config } from "../config.js";
import { logger } from "../logger.js";

export interface WorkerCallbacks {
  onProgress?: (p: ProgressMessage) => void;
}

export type WorkerOutcome =
  | { kind: "result"; message: ResultMessage }
  | { kind: "not_found"; message: NotFoundMessage }
  | { kind: "cancelled"; message: CancelledMessage }
  | { kind: "error"; message: ErrorMessage };

export class WorkerJob {
  private readonly proc;
  private cancelled = false;

  constructor(
    private readonly req: WorkerSearchRequest,
    private readonly callbacks: WorkerCallbacks,
  ) {
    this.proc = spawn(config.workerPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdin.write(JSON.stringify(this.req) + "\n");
    this.proc.stdin.end();
    this.proc.stderr.on("data", (chunk: Buffer) => {
      logger.debug({ worker_stderr: chunk.toString("utf8").trim() }, "worker stderr");
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // proc may have already exited; safe to ignore
    }
  }

  async wait(): Promise<WorkerOutcome> {
    let buf = "";
    let outcome: WorkerOutcome | null = null;

    return await new Promise<WorkerOutcome>((resolve, reject) => {
      this.proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: WorkerMessage;
          try {
            msg = JSON.parse(line) as WorkerMessage;
          } catch (err) {
            logger.warn({ err, line }, "failed to parse worker line");
            continue;
          }
          switch (msg.type) {
            case "progress":
              this.callbacks.onProgress?.(msg);
              break;
            case "result":
              outcome = { kind: "result", message: msg };
              break;
            case "not_found":
              outcome = { kind: "not_found", message: msg };
              break;
            case "cancelled":
              outcome = { kind: "cancelled", message: msg };
              break;
            case "error":
              outcome = { kind: "error", message: msg };
              break;
          }
        }
      });

      this.proc.on("error", (err) => reject(err));

      this.proc.on("close", () => {
        if (outcome) {
          resolve(outcome);
        } else if (this.cancelled) {
          resolve({
            kind: "cancelled",
            message: { type: "cancelled", seeds_tested: 0, elapsed_ms: 0 },
          });
        } else {
          resolve({
            kind: "error",
            message: { type: "error", message: "worker_exited_without_result" },
          });
        }
      });
    });
  }
}

export function runWorker(
  req: WorkerSearchRequest,
  callbacks: WorkerCallbacks = {},
): WorkerJob {
  return new WorkerJob(req, callbacks);
}

/**
 * Resolves real coordinates for an explicit seed by spawning the worker in
 * `resolve` mode. The seed is assumed to already satisfy the spec (cache
 * hits guarantee this); the worker probes it once and emits the same
 * `result` line shape as a normal search would.
 */
export async function resolveSeed(
  req: WorkerSearchRequest & { seed: string },
): Promise<ResultMessage | ErrorMessage> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(config.workerPath, ["resolve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.write(JSON.stringify(req) + "\n");
    proc.stdin.end();
    proc.stderr.on("data", (chunk: Buffer) => {
      logger.debug({ worker_stderr: chunk.toString("utf8").trim() }, "resolve stderr");
    });
    let buf = "";
    let parsed: ResultMessage | ErrorMessage | null = null;
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as WorkerMessage;
          if (msg.type === "result" || msg.type === "error") parsed = msg;
        } catch (err) {
          logger.warn({ err, line }, "failed to parse resolve line");
        }
      }
    });
    proc.on("error", reject);
    proc.on("close", () => {
      resolve(
        parsed ?? { type: "error", message: "resolve_exited_without_result" },
      );
    });
  });
}
