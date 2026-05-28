/**
 * Filter validity heuristics — predict, BEFORE launching a live search,
 * whether a (biomes, structures, radius) combination has a reasonable
 * chance of physically existing in a Minecraft world.
 *
 * The goal is to stop users from waiting 5 minutes on a search that
 * cannot possibly succeed (e.g. "mushroom fields next to ice spikes
 * within 200 blocks" — these belong to opposite climate zones and the
 * climate noise gradient in cubiomes simply cannot transition between
 * them at that scale).
 *
 * The heuristics deliberately err on the side of NOT blocking searches.
 * Returning `severity: 'red'` only happens when at least one anchor
 * relationship is physically violated; otherwise we return 'warn' or
 * 'ok' and let the user decide. Every `red` and `warn` carries a human
 * reason so the bot UI can render an actionable warning.
 *
 * Implementation notes:
 *   • Climate zones are based on cubiomes' temperature/humidity buckets
 *     (warm/wet/cold/frozen) plus the special "mushroom" and "ocean"
 *     groups that live outside the regular grid.
 *   • Structure anchor zones come from cubiomes' biome constraint
 *     tables (see structureValidBiomes in cubiomes/finders.c). We
 *     replicate just enough of them here to flag the obvious cases.
 *   • `rarityScore` multiplies the per-element rarity prior on top of
 *     a radius factor; tiny scores at small radii get flagged.
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

  /* 2. Structure anchor compatibility. */
  if (input.biomes.length > 0) {
    const biomeSet = new Set(input.biomes);
    for (const sid of input.structures) {
      const anchors = structureAnchors(sid);
      if (!anchors || anchors.length === 0) continue;
      const overlap = anchors.some((b) => biomeSet.has(b));
      if (overlap) continue;
      /* Structure cannot spawn in any of the user's chosen biomes. We
       * also check whether at least one of its anchor biomes shares a
       * climate zone with one of the chosen biomes — if not, the user
       * needs both a different biome AND a different placement to ever
       * see this combo. */
      const anchorZones = new Set(anchors.map(biomeZone));
      const userZones = new Set(input.biomes.map(biomeZone));
      const zoneOverlap = [...anchorZones].some((z) => userZones.has(z));
      warnings.push({
        severity: zoneOverlap ? "warn" : "red",
        reason: `«${nameOfStructure(sid)}» появляется только в биомах ${anchors
          .map(nameOfBiome)
          .join(" / ")}, а в твоём фильтре их нет.`,
      });
    }
  }

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

function nameOfStructure(id: string): string {
  try {
    return getStructure(id).nameRu;
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
