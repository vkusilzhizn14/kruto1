/**
 * Postgres connection + migration runner.
 *
 * Migrations are plain SQL files in `db/migrations/NNN_*.sql`. Each is
 * applied exactly once and recorded in `schema_migrations`.
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import pkg from "pg";

import { config } from "../config.js";
import { logger } from "../logger.js";

const { Pool } = pkg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 16,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "pg pool error");
});

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );
  const files = (await readdir(config.migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(resolve(config.migrationsDir, file), "utf8");
    logger.info({ file }, "applying migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error({ err, file }, "migration failed");
      throw err;
    } finally {
      client.release();
    }
  }
}
