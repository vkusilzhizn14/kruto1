/**
 * Search radii exposed in the bot UI.
 *
 * Tight radii are more valuable (the structure/biome is literally near
 * spawn) but require more compute to find — most seeds will not satisfy a
 * tight-radius constraint, so the live search must test more candidates.
 *
 * Radii are stored as `bucket` integers in the seed cache so we can index
 * one row per (seed, bucket) for fast lookups; each bucket corresponds to a
 * specific block radius.
 */

export interface RadiusInfo {
  readonly id: string;
  readonly nameRu: string;
  readonly blocks: number;
  /** Bucket index used as a column suffix in the seed cache schema. */
  readonly bucket: 0 | 1 | 2 | 3;
}

export const RADII: readonly RadiusInfo[] = [
  { id: "100", nameRu: "На спавне (100 блоков)", blocks: 100, bucket: 0 },
  { id: "200", nameRu: "Совсем рядом (200 блоков)", blocks: 200, bucket: 1 },
  { id: "500", nameRu: "Близко (500 блоков)", blocks: 500, bucket: 2 },
  { id: "1000", nameRu: "Чуть дальше (1000 блоков)", blocks: 1000, bucket: 3 },
] as const;

const BY_ID = new Map<string, RadiusInfo>(RADII.map((r) => [r.id, r]));

export function getRadius(id: string): RadiusInfo {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`Unknown radius: ${id}`);
  return r;
}
