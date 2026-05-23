/**
 * Catalog of biomes exposed to the user in the bot UI.
 *
 * `cubiomesEnum` matches the identifier in cubiomes' `biomes.h`. `id` is a
 * stable short string used in storage and protocol; `bit` is the bit position
 * used in the seed-cache bitmask (max 64 biomes; this list stays under that
 * limit on purpose).
 *
 * `rarity` is an approximate per-seed presence probability within a 500-block
 * radius around (0,0) for overworld biomes (estimated from cubiomes sampling
 * on ~10k random seeds). It is used by the worker to order filter checks from
 * rarest to most common — the rarest filter rejects unmatched seeds fastest.
 *
 * `minVersion` controls availability per Minecraft version. Most biomes are
 * shared between 1.20 and 1.21.
 */

import type { McVersion } from "./versions.js";

export interface BiomeInfo {
  /** Stable short identifier (snake_case). */
  readonly id: string;
  /** Russian display name (the bot UI is Russian-first). */
  readonly nameRu: string;
  /** English display name (for logs / advanced UI). */
  readonly nameEn: string;
  /** Emoji used in inline keyboards. */
  readonly emoji: string;
  /** Cubiomes enum name from biomes.h. */
  readonly cubiomesEnum: string;
  /** Bit position in the seed cache bitmask (0-63). */
  readonly bit: number;
  /** Approximate presence probability per seed within 500 blocks of (0,0). */
  readonly rarity: number;
  /** Earliest MC version that supports this biome. */
  readonly minVersion: McVersion;
}

// Bits 0-31: common overworld biomes
// Bits 32-47: rare / version-gated biomes
// Bits 48-63: reserved for future expansion (e.g. nether/end biomes)
export const BIOMES: readonly BiomeInfo[] = [
  // Common / temperate
  { id: "plains", nameRu: "Равнины", nameEn: "Plains", emoji: "🌾", cubiomesEnum: "plains", bit: 0, rarity: 0.92, minVersion: "1.20" },
  { id: "forest", nameRu: "Лес", nameEn: "Forest", emoji: "🌳", cubiomesEnum: "forest", bit: 1, rarity: 0.88, minVersion: "1.20" },
  { id: "birch_forest", nameRu: "Берёзовый лес", nameEn: "Birch Forest", emoji: "🌲", cubiomesEnum: "birch_forest", bit: 2, rarity: 0.55, minVersion: "1.20" },
  { id: "dark_forest", nameRu: "Тёмный лес", nameEn: "Dark Forest", emoji: "🌑", cubiomesEnum: "dark_forest", bit: 3, rarity: 0.35, minVersion: "1.20" },
  { id: "flower_forest", nameRu: "Цветочный лес", nameEn: "Flower Forest", emoji: "🌸", cubiomesEnum: "flower_forest", bit: 4, rarity: 0.22, minVersion: "1.20" },
  { id: "river", nameRu: "Река", nameEn: "River", emoji: "〰️", cubiomesEnum: "river", bit: 5, rarity: 0.96, minVersion: "1.20" },
  { id: "beach", nameRu: "Пляж", nameEn: "Beach", emoji: "🏖️", cubiomesEnum: "beach", bit: 6, rarity: 0.78, minVersion: "1.20" },

  // Warm / dry
  { id: "desert", nameRu: "Пустыня", nameEn: "Desert", emoji: "🏜️", cubiomesEnum: "desert", bit: 7, rarity: 0.62, minVersion: "1.20" },
  { id: "savanna", nameRu: "Саванна", nameEn: "Savanna", emoji: "🦒", cubiomesEnum: "savanna", bit: 8, rarity: 0.58, minVersion: "1.20" },
  { id: "savanna_plateau", nameRu: "Плато саванны", nameEn: "Savanna Plateau", emoji: "🪵", cubiomesEnum: "savanna_plateau", bit: 9, rarity: 0.18, minVersion: "1.20" },
  { id: "badlands", nameRu: "Бесплодные земли", nameEn: "Badlands", emoji: "🌵", cubiomesEnum: "badlands", bit: 10, rarity: 0.12, minVersion: "1.20" },
  { id: "wooded_badlands", nameRu: "Леса бесплодных земель", nameEn: "Wooded Badlands", emoji: "🌲", cubiomesEnum: "wooded_badlands", bit: 11, rarity: 0.08, minVersion: "1.20" },

  // Jungle
  { id: "jungle", nameRu: "Джунгли", nameEn: "Jungle", emoji: "🌴", cubiomesEnum: "jungle", bit: 12, rarity: 0.28, minVersion: "1.20" },
  { id: "sparse_jungle", nameRu: "Редкие джунгли", nameEn: "Sparse Jungle", emoji: "🍃", cubiomesEnum: "sparse_jungle", bit: 13, rarity: 0.22, minVersion: "1.20" },
  { id: "bamboo_jungle", nameRu: "Бамбуковые джунгли", nameEn: "Bamboo Jungle", emoji: "🎋", cubiomesEnum: "bamboo_jungle", bit: 14, rarity: 0.14, minVersion: "1.20" },

  // Swamp
  { id: "swamp", nameRu: "Болото", nameEn: "Swamp", emoji: "🐸", cubiomesEnum: "swamp", bit: 15, rarity: 0.48, minVersion: "1.20" },
  { id: "mangrove_swamp", nameRu: "Мангровое болото", nameEn: "Mangrove Swamp", emoji: "🪴", cubiomesEnum: "mangrove_swamp", bit: 16, rarity: 0.11, minVersion: "1.20" },

  // Cold
  { id: "taiga", nameRu: "Тайга", nameEn: "Taiga", emoji: "🌲", cubiomesEnum: "taiga", bit: 17, rarity: 0.72, minVersion: "1.20" },
  { id: "old_growth_pine_taiga", nameRu: "Древняя сосновая тайга", nameEn: "Old Growth Pine Taiga", emoji: "🌲", cubiomesEnum: "old_growth_pine_taiga", bit: 18, rarity: 0.18, minVersion: "1.20" },
  { id: "old_growth_spruce_taiga", nameRu: "Древняя еловая тайга", nameEn: "Old Growth Spruce Taiga", emoji: "🌲", cubiomesEnum: "old_growth_spruce_taiga", bit: 19, rarity: 0.16, minVersion: "1.20" },
  { id: "snowy_plains", nameRu: "Снежные равнины", nameEn: "Snowy Plains", emoji: "❄️", cubiomesEnum: "snowy_plains", bit: 20, rarity: 0.42, minVersion: "1.20" },
  { id: "snowy_taiga", nameRu: "Снежная тайга", nameEn: "Snowy Taiga", emoji: "🌲", cubiomesEnum: "snowy_taiga", bit: 21, rarity: 0.36, minVersion: "1.20" },
  { id: "ice_spikes", nameRu: "Ледяные пики", nameEn: "Ice Spikes", emoji: "🧊", cubiomesEnum: "ice_spikes", bit: 22, rarity: 0.05, minVersion: "1.20" },

  // Mountain biomes
  { id: "meadow", nameRu: "Луг", nameEn: "Meadow", emoji: "🌼", cubiomesEnum: "meadow", bit: 23, rarity: 0.34, minVersion: "1.20" },
  { id: "grove", nameRu: "Роща", nameEn: "Grove", emoji: "🌲", cubiomesEnum: "grove", bit: 24, rarity: 0.22, minVersion: "1.20" },
  { id: "snowy_slopes", nameRu: "Снежные склоны", nameEn: "Snowy Slopes", emoji: "🏔️", cubiomesEnum: "snowy_slopes", bit: 25, rarity: 0.16, minVersion: "1.20" },
  { id: "jagged_peaks", nameRu: "Зубчатые пики", nameEn: "Jagged Peaks", emoji: "⛰️", cubiomesEnum: "jagged_peaks", bit: 26, rarity: 0.12, minVersion: "1.20" },
  { id: "frozen_peaks", nameRu: "Замёрзшие пики", nameEn: "Frozen Peaks", emoji: "🗻", cubiomesEnum: "frozen_peaks", bit: 27, rarity: 0.07, minVersion: "1.20" },
  { id: "stony_peaks", nameRu: "Каменные пики", nameEn: "Stony Peaks", emoji: "🪨", cubiomesEnum: "stony_peaks", bit: 28, rarity: 0.18, minVersion: "1.20" },

  // Ocean (popular for fishing / sea villages)
  { id: "ocean", nameRu: "Океан", nameEn: "Ocean", emoji: "🌊", cubiomesEnum: "ocean", bit: 29, rarity: 0.84, minVersion: "1.20" },
  { id: "warm_ocean", nameRu: "Тёплый океан", nameEn: "Warm Ocean", emoji: "🐠", cubiomesEnum: "warm_ocean", bit: 30, rarity: 0.34, minVersion: "1.20" },
  { id: "frozen_ocean", nameRu: "Замёрзший океан", nameEn: "Frozen Ocean", emoji: "🥶", cubiomesEnum: "frozen_ocean", bit: 31, rarity: 0.28, minVersion: "1.20" },

  // Rare / prized
  { id: "mushroom_fields", nameRu: "Грибные поля", nameEn: "Mushroom Fields", emoji: "🍄", cubiomesEnum: "mushroom_fields", bit: 32, rarity: 0.012, minVersion: "1.20" },
  { id: "cherry_grove", nameRu: "Вишнёвая роща", nameEn: "Cherry Grove", emoji: "🌸", cubiomesEnum: "cherry_grove", bit: 33, rarity: 0.018, minVersion: "1.20" },
  { id: "deep_dark", nameRu: "Глубокая тьма", nameEn: "Deep Dark", emoji: "🕳️", cubiomesEnum: "deep_dark", bit: 34, rarity: 0.06, minVersion: "1.20" },
  { id: "lush_caves", nameRu: "Пышные пещеры", nameEn: "Lush Caves", emoji: "🌿", cubiomesEnum: "lush_caves", bit: 35, rarity: 0.08, minVersion: "1.20" },
  { id: "dripstone_caves", nameRu: "Капельные пещеры", nameEn: "Dripstone Caves", emoji: "🪨", cubiomesEnum: "dripstone_caves", bit: 36, rarity: 0.18, minVersion: "1.20" },
  { id: "pale_garden", nameRu: "Бледный сад", nameEn: "Pale Garden", emoji: "🌫️", cubiomesEnum: "pale_garden", bit: 37, rarity: 0.014, minVersion: "1.21" },
] as const;

const BY_ID = new Map<string, BiomeInfo>(BIOMES.map((b) => [b.id, b]));

export function getBiome(id: string): BiomeInfo {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`Unknown biome: ${id}`);
  return b;
}

export function biomeAvailableInVersion(b: BiomeInfo, version: McVersion): boolean {
  return version >= b.minVersion;
}

export function biomesForVersion(version: McVersion): readonly BiomeInfo[] {
  return BIOMES.filter((b) => biomeAvailableInVersion(b, version));
}

/** Build a 64-bit bitmask from a list of biome ids. */
export function biomeMask(ids: readonly string[]): bigint {
  let mask = 0n;
  for (const id of ids) {
    const b = getBiome(id);
    mask |= 1n << BigInt(b.bit);
  }
  return mask;
}
