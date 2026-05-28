/**
 * Rare-combo explorer — background worker that generates random combinations
 * of rare biomes and structures, searches for matching seeds, and caches the
 * results so future user queries get instant responses.
 *
 * Runs continuously when the server is idle, yields to real user requests.
 */

import {
  BIOMES,
  type McVersion,
  STRUCTURES,
  getRadius,
} from "@kruto52/shared";

import { config } from "../config.js";
import { logger } from "../logger.js";

import { liveSearchSemaphore } from "./concurrency.js";
import { findSeed } from "./search.js";

/* ------- pool definitions ------- */

const RARE_BIOME_IDS = BIOMES.filter((b) => b.rarity < 0.15).map((b) => b.id);
const RARE_STRUCT_IDS = STRUCTURES.filter(
  (s) => s.rarity > 0 && s.rarity < 0.25,
).map((s) => s.id);
const ALL_BIOME_IDS = BIOMES.map((b) => b.id);
const ALL_STRUCT_IDS = STRUCTURES.filter((s) => s.rarity > 0).map(
  (s) => s.id,
);

const RADII = ["100", "200", "500"] as const;

/* ------- helpers ------- */

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickN<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]!);
  }
  return out;
}

interface GeneratedCombo {
  biomes: string[];
  structures: string[];
  radius: string;
  mc: McVersion;
  label: string;
}

function generateCombo(): GeneratedCombo {
  const radius = pickRandom(RADII);
  const mc: McVersion = "1.21";

  const roll = Math.random();
  let biomes: string[];
  let structures: string[];

  if (roll < 0.2) {
    // Solo rare structure
    structures = [pickRandom(RARE_STRUCT_IDS)];
    biomes = [];
  } else if (roll < 0.35) {
    // Solo rare biome
    biomes = [pickRandom(RARE_BIOME_IDS)];
    structures = [];
  } else if (roll < 0.55) {
    // 1 rare structure + 1 biome (any)
    structures = [pickRandom(RARE_STRUCT_IDS)];
    biomes = [pickRandom(ALL_BIOME_IDS)];
  } else if (roll < 0.7) {
    // 1 rare biome + 1 structure (any)
    biomes = [pickRandom(RARE_BIOME_IDS)];
    structures = [pickRandom(ALL_STRUCT_IDS)];
  } else if (roll < 0.8) {
    // 2 structures
    structures = pickN(ALL_STRUCT_IDS, 2);
    biomes = [];
  } else if (roll < 0.9) {
    // 2 rare biomes
    biomes = pickN(RARE_BIOME_IDS, 2);
    structures = [];
  } else {
    // Perfect spawn: 2 structures + 1 biome in r=500
    structures = pickN(ALL_STRUCT_IDS, 2);
    biomes = [pickRandom(ALL_BIOME_IDS)];
    const label = [...biomes, ...structures].join("+") + " r=500";
    return { biomes, structures, radius: "500", mc, label };
  }

  const label = [...biomes, ...structures].join("+") + ` r=${radius}`;
  return { biomes, structures, radius, mc, label };
}

/* ------- state ------- */

const failedCombos = new Set<string>();
let totalFound = 0;
let totalCacheHits = 0;
let totalFailed = 0;

/* ------- tick ------- */

async function explorerTick(): Promise<void> {
  // Yield to real users: if someone is using (or waiting for) the live
  // search semaphore, skip this tick entirely.
  if (liveSearchSemaphore.queued > 0 || liveSearchSemaphore.inFlight > 0) {
    return;
  }

  const combo = generateCombo();
  const comboKey = [
    combo.mc,
    [...combo.biomes].sort().join(","),
    [...combo.structures].sort().join(","),
    combo.radius,
  ].join("|");

  if (failedCombos.has(comboKey)) {
    return;
  }

  const result = await findSeed({
    userId: 0,
    mc: combo.mc,
    largeBiomes: false,
    radius: getRadius(combo.radius),
    biomeIds: combo.biomes,
    structureIds: combo.structures,
    allowLiveSearch: true,
    timeoutMs: config.explorerTimeoutMs,
    isBackground: true,
  });

  if (result.ok) {
    if (result.outcome.source === "live") {
      totalFound++;
      logger.info(
        {
          combo: combo.label,
          seed: result.outcome.seed.toString(),
          elapsedMs: result.outcome.elapsedMs,
        },
        "explorer: new rare seed found",
      );
    } else {
      totalCacheHits++;
    }
  } else {
    failedCombos.add(comboKey);
    totalFailed++;
    if (result.reason !== "not_found") {
      logger.debug(
        { combo: combo.label, reason: result.reason },
        "explorer: combo failed",
      );
    }
  }
}

/* ------- loop ------- */

export function startExplorerLoop(): void {
  if (!config.explorerEnabled) return;

  logger.info(
    {
      rareBiomes: RARE_BIOME_IDS.length,
      rareStructures: RARE_STRUCT_IDS.length,
      intervalSec: config.explorerIntervalSec,
    },
    "rare-combo explorer starting",
  );

  const loop = async (): Promise<void> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await explorerTick();
      } catch (err) {
        logger.warn({ err }, "explorer tick error");
      }
      await new Promise<void>((r) =>
        setTimeout(r, config.explorerIntervalSec * 1000),
      );
    }
  };

  // Start after 30 seconds (let bot finish booting).
  setTimeout(() => {
    void loop();
    logger.info("rare-combo explorer loop running");
  }, 30_000);
}

/** Stats for the /admin or /stats command. */
export function explorerStats(): {
  found: number;
  cacheHits: number;
  failed: number;
  failedCombosSize: number;
} {
  return {
    found: totalFound,
    cacheHits: totalCacheHits,
    failed: totalFailed,
    failedCombosSize: failedCombos.size,
  };
}
