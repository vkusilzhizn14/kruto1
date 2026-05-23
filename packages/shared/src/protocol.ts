/**
 * JSON line-delimited protocol between the TypeScript bot and the C worker.
 *
 * The bot writes one request as a JSON object terminated by `\n` to the
 * worker's stdin. The worker streams zero or more `progress` lines, followed
 * by exactly one terminal message (`result`, `not_found`, `cancelled`, or
 * `error`).
 *
 * Cancellation is performed by sending SIGTERM to the worker process from
 * the bot. The worker checks the cancel flag between seed iterations and
 * exits with a single `{"type":"cancelled"}` line.
 */

export interface WorkerSearchRequest {
  readonly id: string;
  readonly mc: "1.20" | "1.21";
  readonly large_biomes: boolean;
  /** Maximum allowed distance (in blocks) from spawn (0,0) for each match. */
  readonly radius: number;
  readonly biomes: readonly string[];
  readonly structures: readonly string[];
  /** Seeds to skip (already returned to this user). */
  readonly exclude_seeds: readonly string[];
  /** Hard cap on seeds to test before giving up. */
  readonly max_seeds: number;
  /** Hard timeout in milliseconds. */
  readonly timeout_ms: number;
  /** Worker threads to use (defaults to all available cores). */
  readonly threads?: number;
  /** Starting seed for the search (default: random). */
  readonly start_seed?: string;
}

export interface ProgressMessage {
  readonly type: "progress";
  readonly seeds_tested: number;
  readonly seeds_per_sec: number;
  readonly elapsed_ms: number;
}

export interface ResultMessage {
  readonly type: "result";
  readonly seed: string;
  readonly spawn: { x: number; z: number };
  readonly biomes: ReadonlyArray<{ id: string; x: number; z: number }>;
  readonly structures: ReadonlyArray<{ id: string; x: number; z: number }>;
  readonly seeds_tested: number;
  readonly elapsed_ms: number;
}

export interface NotFoundMessage {
  readonly type: "not_found";
  readonly reason: "exhausted" | "timeout";
  readonly seeds_tested: number;
  readonly elapsed_ms: number;
}

export interface CancelledMessage {
  readonly type: "cancelled";
  readonly seeds_tested: number;
  readonly elapsed_ms: number;
}

export interface ErrorMessage {
  readonly type: "error";
  readonly message: string;
}

export type WorkerMessage =
  | ProgressMessage
  | ResultMessage
  | NotFoundMessage
  | CancelledMessage
  | ErrorMessage;
