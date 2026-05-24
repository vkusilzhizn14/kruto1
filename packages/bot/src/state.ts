/**
 * Persistent picker state for the /search wizard.
 *
 * Originally an in-memory Map keyed on chatId; that worked while the
 * bot was up but every restart wiped the state, which made stale
 * inline buttons ("Найти другой") issue searches against the default
 * empty filter (no biomes, no structures, radius 500) — the cache
 * happily returned the first matching seed and the user saw what
 * looked like a "random" result.
 *
 * Now we keep the same in-memory Map for fast lookups but also
 * write-through every change to the `picker_state` table. On bot
 * startup `hydratePickerState()` re-populates the Map from DB so old
 * result-message buttons keep working across restarts.
 *
 * State is intentionally write-through (not async lazy-load) so the
 * existing synchronous `getState` / `setState` API doesn't need to be
 * async at every call site. Database writes are fire-and-forget;
 * failures are logged but don't break the user-visible flow because
 * the in-memory copy is authoritative for the running process.
 */

import { type McVersion, type RadiusInfo, getRadius } from "@kruto52/shared";

import { pool } from "./services/db.js";
import { logger } from "./logger.js";

export interface PickerState {
  version: McVersion;
  radius: RadiusInfo;
  biomes: Set<string>;
  structures: Set<string>;
  page: { biomes: number; structures: number };
  /** Seeds already returned to this user for this exact filter set. */
  excludeSeeds: Set<string>;
}

export type PickerKind = "biomes" | "structures";

const STATE: Map<number, PickerState> = new Map();

export function getState(chatId: number, init: () => PickerState): PickerState {
  const existing = STATE.get(chatId);
  if (existing) return existing;
  const fresh = init();
  STATE.set(chatId, fresh);
  return fresh;
}

export function setState(chatId: number, state: PickerState): void {
  STATE.set(chatId, state);
  /* Fire-and-forget: in-memory is authoritative for the running bot;
   * DB is a backup for restart recovery. We never await this so the
   * search wizard stays snappy. */
  persistState(chatId, state).catch((err) => {
    logger.warn({ err, chatId }, "picker_state write failed");
  });
}

export function clearState(chatId: number): void {
  STATE.delete(chatId);
  pool
    .query("DELETE FROM picker_state WHERE chat_id = $1", [chatId])
    .catch((err) => logger.warn({ err, chatId }, "picker_state delete failed"));
}

async function persistState(chatId: number, state: PickerState): Promise<void> {
  await pool.query(
    `INSERT INTO picker_state (
        chat_id, version, radius, biome_ids, structure_ids, exclude_seeds,
        page_biomes, page_structures, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5::text[], $6::text[], $7, $8, NOW())
     ON CONFLICT (chat_id) DO UPDATE SET
       version          = EXCLUDED.version,
       radius           = EXCLUDED.radius,
       biome_ids        = EXCLUDED.biome_ids,
       structure_ids    = EXCLUDED.structure_ids,
       exclude_seeds    = EXCLUDED.exclude_seeds,
       page_biomes      = EXCLUDED.page_biomes,
       page_structures  = EXCLUDED.page_structures,
       updated_at       = NOW()`,
    [
      chatId,
      state.version,
      state.radius.blocks,
      Array.from(state.biomes),
      Array.from(state.structures),
      Array.from(state.excludeSeeds),
      state.page.biomes,
      state.page.structures,
    ],
  );
}

/**
 * Loads persisted picker states from the DB into memory. Called once
 * at bot startup. Rows older than 30 days are skipped (stale enough
 * that the user has almost certainly moved on); they remain on disk
 * and will be GC'd by a future cleanup job.
 */
export async function hydratePickerState(): Promise<void> {
  let restored = 0;
  try {
    const { rows } = await pool.query<{
      chat_id: string;
      version: string;
      radius: number;
      biome_ids: string[];
      structure_ids: string[];
      exclude_seeds: string[];
      page_biomes: number;
      page_structures: number;
    }>(
      `SELECT chat_id::text, version, radius, biome_ids, structure_ids,
              exclude_seeds, page_biomes, page_structures
         FROM picker_state
        WHERE updated_at > NOW() - INTERVAL '30 days'`,
    );
    for (const row of rows) {
      const chatId = Number(row.chat_id);
      if (!Number.isFinite(chatId)) continue;
      let radius: RadiusInfo;
      try {
        radius = getRadius(String(row.radius));
      } catch {
        /* unknown radius value in DB — skip rather than crash. */
        continue;
      }
      const state: PickerState = {
        version: row.version as McVersion,
        radius,
        biomes: new Set(row.biome_ids ?? []),
        structures: new Set(row.structure_ids ?? []),
        page: { biomes: row.page_biomes ?? 0, structures: row.page_structures ?? 0 },
        excludeSeeds: new Set(row.exclude_seeds ?? []),
      };
      STATE.set(chatId, state);
      restored++;
    }
  } catch (err) {
    /* picker_state table not yet created (first run after the migration
     * is applied is fine; this would only fail if the table is missing
     * on a much older DB). Don't crash startup over it. */
    logger.warn({ err }, "picker_state hydrate failed; starting empty");
  }
  logger.info({ restored }, "picker_state hydrated");
}
