/**
 * Tiny HTTP health-check server.
 *
 * Exposes a single `GET /healthz` endpoint that returns 200 with a small
 * JSON payload describing live-search saturation and Postgres reachability.
 * Used by:
 *   • the Docker healthcheck (`HEALTHCHECK CMD wget -qO- /healthz`)
 *   • external uptime monitors (UptimeRobot, BetterStack, Healthchecks.io)
 *
 * The server intentionally has no auth and no /metrics endpoint — it just
 * needs to confirm the Node process is alive and can talk to the DB.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { config } from "../config.js";
import { logger } from "../logger.js";

import { liveSearchSemaphore } from "./concurrency.js";
import { pool } from "./db.js";

interface HealthBody {
  status: "ok" | "degraded";
  uptime_sec: number;
  db: "ok" | "error";
  live_search: {
    in_flight: number;
    queued: number;
    limit: number;
  };
  error?: string;
}

async function pingDb(): Promise<{ ok: true } | { ok: false; err: string }> {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, err: (err as Error).message };
  }
}

async function handleHealthz(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = await pingDb();
  const body: HealthBody = {
    status: db.ok ? "ok" : "degraded",
    uptime_sec: Math.floor(process.uptime()),
    db: db.ok ? "ok" : "error",
    live_search: {
      in_flight: liveSearchSemaphore.inFlight,
      queued: liveSearchSemaphore.queued,
      limit: liveSearchSemaphore.limit,
    },
  };
  if (!db.ok) body.error = db.err;
  res.statusCode = db.ok ? 200 : 503;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function startHealthServer(): void {
  if (config.healthPort <= 0) {
    logger.info("health server disabled (HEALTH_PORT=0)");
    return;
  }
  const server = createServer((req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      void handleHealthz(req, res);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.listen(config.healthPort, "0.0.0.0", () => {
    logger.info({ port: config.healthPort }, "health server listening");
  });
  server.on("error", (err) => {
    logger.error({ err }, "health server error");
  });
}
