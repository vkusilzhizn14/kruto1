/*
 * Lookup tables and helpers shared across the worker and precompute tools.
 *
 * The bot identifies biomes, structures and Minecraft versions by short
 * string ids; the worker translates these into the integer constants from
 * cubiomes (`biomes.h` and `finders.h`).
 *
 * Keep this in sync with `packages/shared/src/biomes.ts` and
 * `packages/shared/src/structures.ts`.
 */

#ifndef KR_UTIL_H
#define KR_UTIL_H

#include <stdbool.h>
#include <stdint.h>

#include "biomes.h"
#include "finders.h"
#include "generator.h"

/* ---- Biomes ---- */

typedef struct {
    const char *id;
    int cubiomes_id;
    int bit;
    double rarity;
} BiomeRow;

extern const BiomeRow BIOMES[];
extern const size_t BIOMES_LEN;

/* Look up a biome by id. Returns NULL if not found. */
const BiomeRow *lookup_biome(const char *id);

/* ---- Structures ---- */

typedef struct {
    const char *id;
    int cubiomes_type;
    int bit;
    double rarity;
} StructRow;

extern const StructRow STRUCTS[];
extern const size_t STRUCTS_LEN;

const StructRow *lookup_structure(const char *id);

/* ---- Versions ---- */

int lookup_mc_version(const char *id);

/* ---- Tiny utils ---- */

uint64_t now_ms(void);
uint64_t mix64(uint64_t x);

#endif /* KR_UTIL_H */
