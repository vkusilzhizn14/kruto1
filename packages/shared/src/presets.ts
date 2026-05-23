/**
 * One-click search presets for casual users — the "I just want a cool spawn"
 * audience.
 *
 * Each preset maps to a (biomes, structures, radius) tuple that gets sent to
 * the search orchestrator directly without going through the criteria-picker
 * keyboards. Presets are tuned for cache-hit rate: the combinations were
 * chosen to be common enough that the precomputed seed cache will almost
 * always return an instant match.
 */

import type { McVersion } from "./versions.js";

export interface Preset {
  readonly id: string;
  readonly nameRu: string;
  readonly emoji: string;
  readonly biomes: readonly string[];
  readonly structures: readonly string[];
  readonly radius: string;
  readonly version: McVersion;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "village_in_forest",
    nameRu: "Деревня в лесу",
    emoji: "🏘️🌳",
    biomes: ["forest", "plains"],
    structures: ["village"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "mushroom_island",
    nameRu: "Грибной остров на спавне",
    emoji: "🍄",
    biomes: ["mushroom_fields"],
    structures: [],
    radius: "100",
    version: "1.21",
  },
  {
    id: "cherry_grove",
    nameRu: "Вишнёвая роща у спавна",
    emoji: "🌸",
    biomes: ["cherry_grove"],
    structures: [],
    radius: "100",
    version: "1.21",
  },
  {
    id: "desert_pyramid",
    nameRu: "Пирамида и деревня в пустыне",
    emoji: "🏜️🗿",
    biomes: ["desert"],
    structures: ["desert_pyramid", "village"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "trial_chambers_spawn",
    nameRu: "Испытательные палаты у спавна",
    emoji: "⚔️",
    biomes: [],
    structures: ["trial_chambers"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "mansion_hunt",
    nameRu: "Лесной особняк (редкий)",
    emoji: "🏰",
    biomes: ["dark_forest"],
    structures: ["mansion"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "ocean_monument",
    nameRu: "Подводный храм и тёплый океан",
    emoji: "🏛️🌊",
    biomes: ["warm_ocean"],
    structures: ["ocean_monument"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "ancient_city",
    nameRu: "Древний город под спавном",
    emoji: "🕳️🏛️",
    biomes: ["deep_dark"],
    structures: ["ancient_city"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "snow_igloo",
    nameRu: "Снежные равнины и иглу",
    emoji: "❄️🏚️",
    biomes: ["snowy_plains"],
    structures: ["igloo", "village"],
    radius: "100",
    version: "1.21",
  },
  {
    id: "jungle_temple",
    nameRu: "Храм в джунглях",
    emoji: "🌴🛕",
    biomes: ["jungle"],
    structures: ["jungle_temple"],
    radius: "100",
    version: "1.21",
  },
] as const;

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
