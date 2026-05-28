/**
 * Filter validity heuristics — predict, BEFORE launching a live search,
 * whether a (biomes, structures, radius) combination is PHYSICALLY
 * IMPOSSIBLE (not just rare) in a Minecraft world.
 *
 * Эволюция эвристики (п.10, 2026-05-28):
 *   До: также ругался на типа «выбрали деревню без plains/desert» — это false-positive,
 *   потому что деревня спокойно может быть в радиусе в своём биоме (plains),
 *   а выбранный юзером биом (например forest) — в другой точке радиуса.
 *   Поиск вполне возможен.
 *
 *   После: red бывает ТОЛЬКО когда в самом фильтре биомы из несовместимых
 *   климатических зон (mushroom_fields + jungle, snowy_plains + desert).
 *   Это физически невозможно в радиусе 200+ блоков, так как climate
 *   noise в cubiomes просто не успевает перейти между крайностями.
 *
 *   Редкие комбинации (редкие биомы + малый радиус) остаются warn,
 *   никогда не блокируем. Юзер видит жёлтое предупреждение и решает сам.
 *
 * Implementation notes:
 *   • Climate zones are based on cubiomes' temperature/humidity buckets
 *     (warm/wet/cold/frozen) plus the special "mushroom" and "ocean"
 *     groups that live outside the regular grid.
 *   • `rarityScore` multiplies the per-element rarity prior on top of
 *     a radius factor; tiny scores at small radii get flagged as "warn"
 *     (никогда как red).
 */

import { getBiome } from "./biomes.js";
import { type RadiusInfo } from "./radius.js";
import { getStructure } from "./structures.js";

/* ----------------------- climate classification ----------------------- */

/**
 * Coarse climate / placement bucket for a biome. Biomes in
 * incompatible buckets cannot generate adjacent to each other within
 * short distances because cubiomes' climate noise needs many blocks to
 * transition between extremes.
 */
export type ClimateZone =
  | "hot_dry"
  | "warm_wet"
  | "temperate"
  | "cold"
  | "frozen"
  | "mountain"
  | "ocean"
  | "mushroom"
  | "underground"
  | "special";

const BIOME_ZONE: Record<string, ClimateZone> = {
  // temperate continental
  plains: "temperate",
  forest: "temperate",
  birch_forest: "temperate",
  dark_forest: "temperate",
  flower_forest: "temperate",
  river: "temperate",
  beach: "temperate",
  // hot/dry
  desert: "hot_dry",
  savanna: "hot_dry",
  savanna_plateau: "hot_dry",
  badlands: "hot_dry",
  wooded_badlands: "hot_dry",
  // warm/wet
  jungle: "warm_wet",
  sparse_jungle: "warm_wet",
  bamboo_jungle: "warm_wet",
  swamp: "warm_wet",
  mangrove_swamp: "warm_wet",
  // cold/taiga
  taiga: "cold",
  old_growth_pine_taiga: "cold",
  old_growth_spruce_taiga: "cold",
  // frozen
  snowy_plains: "frozen",
  snowy_taiga: "frozen",
  ice_spikes: "frozen",
  frozen_ocean: "frozen",
  frozen_peaks: "frozen",
  // mountain (vertical biome — can sit on top of any climate)
  meadow: "mountain",
  grove: "mountain",
  snowy_slopes: "mountain",
  jagged_peaks: "mountain",
  stony_peaks: "mountain",
  cherry_grove: "mountain",
  // ocean
  ocean: "ocean",
  warm_ocean: "ocean",
  // mushroom (always isolated island)
  mushroom_fields: "mushroom",
  // underground / cave
  deep_dark: "underground",
  lush_caves: "underground",
  dripstone_caves: "underground",
  // special / version-gated
  pale_garden: "special",
};

export function biomeZone(biomeId: string): ClimateZone {
  return BIOME_ZONE[biomeId] ?? "temperate";
}

/**
 * Pairs of climate zones that almost never appear within a short
 * radius of each other. Order-independent; the assess function checks
 * both directions.
 */
const ZONE_INCOMPATIBILITY = new Set<string>([
  // hot ↔ frozen — opposite ends of cubiomes' temperature noise
  "frozen|hot_dry",
  "frozen|warm_wet",
  // mushroom is an isolated island biome, always far from anything else
  "mushroom|hot_dry",
  "mushroom|warm_wet",
  "mushroom|temperate",
  "mushroom|cold",
  "mushroom|frozen",
  "mushroom|mountain",
]);

function zonePairKey(a: ClimateZone, b: ClimateZone): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function zonesAreIncompatible(a: ClimateZone, b: ClimateZone): boolean {
  if (a === b) return false;
  return ZONE_INCOMPATIBILITY.has(zonePairKey(a, b));
}

/* ----------------- structure anchor biomes ----------------- */

/**
 * For each structure, the set of biomes it is allowed to generate in
 * (mirrors cubiomes' `isViableStructurePos`). When the user has any
 * biome filter applied, we check that at least one of its biomes
 * intersects with the structure's anchor set — if not, the structure
 * cannot exist inside the requested biome filter at all.
 *
 * Structures with empty anchor sets generate anywhere overworld and
 * are skipped from the anchor check.
 */
const STRUCTURE_ANCHORS: Record<string, readonly string[]> = {
  village: [
    "plains",
    "desert",
    "savanna",
    "taiga",
    "snowy_plains",
  ],
  pillager_outpost: [
    "plains",
    "desert",
    "savanna",
    "taiga",
    "snowy_plains",
    "snowy_taiga",
    "meadow",
    "grove",
  ],
  swamp_hut: ["swamp"],
  igloo: ["snowy_plains", "snowy_taiga", "snowy_slopes"],
  desert_pyramid: ["desert"],
  jungle_temple: ["jungle", "bamboo_jungle"],
  ocean_monument: ["ocean", "warm_ocean", "frozen_ocean"],
  ocean_ruin: ["ocean", "warm_ocean", "frozen_ocean", "beach"],
  shipwreck: ["ocean", "warm_ocean", "frozen_ocean", "beach"],
  buried_treasure: ["beach"],
  mansion: ["dark_forest"],
  ancient_city: ["deep_dark"],
  trail_ruins: [
    "taiga",
    "old_growth_pine_taiga",
    "old_growth_spruce_taiga",
    "snowy_taiga",
    "jungle",
    "bamboo_jungle",
  ],
  /* trial_chambers / mineshaft / stronghold / ruined_portal generate
   * anywhere underground or across virtually all biomes — skip them. */
};

export function structureAnchors(structureId: string): readonly string[] | null {
  return STRUCTURE_ANCHORS[structureId] ?? null;
}

/* ----------------------- assessment ----------------------- */

export type ValiditySeverity = "ok" | "warn" | "red";

export interface ValidityWarning {
  severity: ValiditySeverity;
  /** Short, user-facing Russian explanation. */
  reason: string;
}

export interface ValidityReport {
  severity: ValiditySeverity;
  warnings: readonly ValidityWarning[];
  /** Rough rarity score — product of priors times radius factor. Smaller = rarer. */
  rarityScore: number;
}

const RADIUS_FACTOR: Record<number, number> = {
  100: 0.05,
  200: 0.2,
  500: 1.0,
  1000: 4.0,
};

export interface ValidityInput {
  biomes: readonly string[];
  structures: readonly string[];
  radius: RadiusInfo;
}

/**
 * Run all heuristics against a filter and return the worst severity
 * plus all individual warnings. Pure function; no I/O.
 */
export function assessFilterValidity(input: ValidityInput): ValidityReport {
  const warnings: ValidityWarning[] = [];

  /* 1. Biome zone compatibility. */
  const zones = input.biomes.map((id) => ({ id, zone: biomeZone(id) }));
  const distinctZones = new Set(zones.map((z) => z.zone));
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i]!;
      const b = zones[j]!;
      if (zonesAreIncompatible(a.zone, b.zone)) {
        warnings.push({
          severity: "red",
          reason: `«${nameOfBiome(a.id)}» и «${nameOfBiome(b.id)}» находятся в несовместимых климатических зонах — рядом физически не появляются.`,
        });
      }
    }
  }
  /* Three or more distinct continental zones in a tiny radius is a
   * soft warning — it's possible but very rare. */
  const continentalZones = [...distinctZones].filter(
    (z) => z !== "underground" && z !== "ocean" && z !== "mountain" && z !== "special",
  );
  if (continentalZones.length >= 3 && input.radius.blocks <= 200) {
    warnings.push({
      severity: "warn",
      reason: `Сразу ${continentalZones.length} разных климатических зон в радиусе ${input.radius.blocks} блоков — встречается крайне редко.`,
    });
  }

  /* 2. Structure anchor compatibility — ВЫПИЛЕНА (п.10).
   *
   * Раньше здесь была проверка типа «юзер выбрал деревню, но в биомах
   * нет plains/desert» — она давала false-positive: деревня может быть
   * в радиусе в своём биоме, а выбранный юзером биом — в другой точке радиуса.
   * Поэтому оставляем только climate-zone-проверку выше. */

  /* 3. Rough rarity score. */
  let rarityScore = 1;
  for (const b of input.biomes) {
    rarityScore *= biomeRarity(b);
  }
  for (const s of input.structures) {
    rarityScore *= structureRarity(s);
  }
  rarityScore *= RADIUS_FACTOR[input.radius.blocks] ?? 1;

  if (rarityScore < 1e-6 && input.radius.blocks < 500) {
    warnings.push({
      severity: "warn",
      reason: `Произведение редкостей очень мало (≈${rarityScore.toExponential(1)}) при таком радиусе. Поиск может занять минуты или не найти ничего.`,
    });
  } else if (rarityScore < 1e-4 && input.radius.blocks < 200) {
    warnings.push({
      severity: "warn",
      reason: `Очень редкая комбинация для радиуса ${input.radius.blocks} блоков — попробуй увеличить радиус.`,
    });
  }

  /* Worst severity across all individual warnings. */
  let severity: ValiditySeverity = "ok";
  for (const w of warnings) {
    if (w.severity === "red") {
      severity = "red";
      break;
    }
    if (w.severity === "warn") severity = "warn";
  }

  return { severity, warnings, rarityScore };
}

/* ----------------------- naming helpers ----------------------- */

function nameOfBiome(id: string): string {
  try {
    return getBiome(id).nameRu;
  } catch {
    return id;
  }
}

function biomeRarity(id: string): number {
  try {
    return getBiome(id).rarity || 0.5;
  } catch {
    return 0.5;
  }
}

function structureRarity(id: string): number {
  try {
    return getStructure(id).rarity || 0.5;
  } catch {
    return 0.5;
  }
}
