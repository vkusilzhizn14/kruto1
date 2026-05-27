/**
 * Catalog of structures exposed in the bot UI.
 *
 * `cubiomesEnum` matches the identifier in cubiomes' `finders.h`. `bit` is the
 * position in the 32-bit structure mask used by the seed cache.
 *
 * `regionSize` (in chunks) and `chunkRange` reflect cubiomes' configuration
 * for the structure; together they give a coarse estimate of how rare the
 * structure is per region. We use these to seed the filter-ordering heuristic
 * — actual rarity per radius is measured at startup via Monte Carlo sampling.
 *
 * Default `rarity` values are the prior estimates used until measurements
 * refine them. Lower number = rarer = applied earlier in the filter cascade.
 */

import type { McVersion } from "./versions.js";

export interface StructureInfo {
  readonly id: string;
  readonly nameRu: string;
  readonly nameEn: string;
  readonly emoji: string;
  readonly cubiomesEnum: string;
  readonly bit: number;
  /** Approximate presence probability per seed within 500 blocks of (0,0). */
  readonly rarity: number;
  readonly minVersion: McVersion;
  /** Cubiomes dimension constant ("DIM_OVERWORLD" only for MVP). */
  readonly dimension: "DIM_OVERWORLD";
}

export const STRUCTURES: readonly StructureInfo[] = [
  // Common
  { id: "village", nameRu: "Деревня", nameEn: "Village", emoji: "🏘️", cubiomesEnum: "Village", bit: 0, rarity: 0.74, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "pillager_outpost", nameRu: "Аванпост разбойников", nameEn: "Pillager Outpost", emoji: "🏯", cubiomesEnum: "Outpost", bit: 1, rarity: 0.42, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "ruined_portal", nameRu: "Разрушенный портал", nameEn: "Ruined Portal", emoji: "🌀", cubiomesEnum: "Ruined_Portal", bit: 2, rarity: 0.82, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "shipwreck", nameRu: "Кораблекрушение", nameEn: "Shipwreck", emoji: "🚢", cubiomesEnum: "Shipwreck", bit: 3, rarity: 0.46, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "buried_treasure", nameRu: "Зарытое сокровище", nameEn: "Buried Treasure", emoji: "💰", cubiomesEnum: "Treasure", bit: 4, rarity: 0.62, minVersion: "1.20", dimension: "DIM_OVERWORLD" },

  // Biome-locked
  { id: "swamp_hut", nameRu: "Хижина ведьмы", nameEn: "Swamp Hut", emoji: "🧙‍♀️", cubiomesEnum: "Swamp_Hut", bit: 5, rarity: 0.18, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "igloo", nameRu: "Иглу", nameEn: "Igloo", emoji: "🏚️", cubiomesEnum: "Igloo", bit: 6, rarity: 0.22, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "desert_pyramid", nameRu: "Пирамида в пустыне", nameEn: "Desert Pyramid", emoji: "🗿", cubiomesEnum: "Desert_Pyramid", bit: 7, rarity: 0.28, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "jungle_temple", nameRu: "Храм в джунглях", nameEn: "Jungle Temple", emoji: "🛕", cubiomesEnum: "Jungle_Temple", bit: 8, rarity: 0.14, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "ocean_monument", nameRu: "Подводный храм", nameEn: "Ocean Monument", emoji: "🏛️", cubiomesEnum: "Monument", bit: 9, rarity: 0.16, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "ocean_ruin", nameRu: "Подводные руины", nameEn: "Ocean Ruin", emoji: "🗿", cubiomesEnum: "Ocean_Ruin", bit: 10, rarity: 0.34, minVersion: "1.20", dimension: "DIM_OVERWORLD" },

  // Rare / premium
  { id: "mansion", nameRu: "Лесной особняк", nameEn: "Woodland Mansion", emoji: "🏰", cubiomesEnum: "Mansion", bit: 11, rarity: 0.022, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "ancient_city", nameRu: "Древний город", nameEn: "Ancient City", emoji: "🏛️", cubiomesEnum: "Ancient_City", bit: 12, rarity: 0.038, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "trail_ruins", nameRu: "Тропа руин", nameEn: "Trail Ruins", emoji: "🪨", cubiomesEnum: "Trail_Ruins", bit: 13, rarity: 0.082, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "trial_chambers", nameRu: "Испытательные палаты", nameEn: "Trial Chambers", emoji: "⚔️", cubiomesEnum: "Trial_Chambers", bit: 14, rarity: 0.058, minVersion: "1.21", dimension: "DIM_OVERWORLD" },
  { id: "mineshaft", nameRu: "Заброшенная шахта", nameEn: "Mineshaft", emoji: "⛏️", cubiomesEnum: "Mineshaft", bit: 15, rarity: 0.94, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
  { id: "stronghold", nameRu: "Крепость", nameEn: "Stronghold", emoji: "🏯", cubiomesEnum: "Feature", bit: 16, rarity: 0.0, minVersion: "1.20", dimension: "DIM_OVERWORLD" },
] as const;

const BY_ID = new Map<string, StructureInfo>(STRUCTURES.map((s) => [s.id, s]));

export function getStructure(id: string): StructureInfo {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Unknown structure: ${id}`);
  return s;
}

export function structureAvailableInVersion(s: StructureInfo, version: McVersion): boolean {
  return version >= s.minVersion;
}

export function structuresForVersion(version: McVersion): readonly StructureInfo[] {
  return STRUCTURES.filter((s) => structureAvailableInVersion(s, version));
}

export function structureMask(ids: readonly string[]): bigint {
  let mask = 0n;
  for (const id of ids) {
    const s = getStructure(id);
    mask |= 1n << BigInt(s.bit);
  }
  return mask;
}

/**
 * Inverse of {@link structureMask}: returns the ids whose bit is set in
 * the given mask. Unknown bits are ignored.
 */
export function structureIdsFromMask(mask: bigint): string[] {
  const out: string[] = [];
  for (const s of STRUCTURES) {
    if ((mask & (1n << BigInt(s.bit))) !== 0n) out.push(s.id);
  }
  return out;
}
