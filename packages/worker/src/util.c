#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

const BiomeRow BIOMES[] = {
    /* Common / temperate */
    { "plains",                 plains,                  0, 0.92 },
    { "forest",                 forest,                  1, 0.88 },
    { "birch_forest",           birch_forest,            2, 0.55 },
    { "dark_forest",            dark_forest,             3, 0.35 },
    { "flower_forest",          flower_forest,           4, 0.22 },
    { "river",                  river,                   5, 0.96 },
    { "beach",                  beach,                   6, 0.78 },
    /* Warm / dry */
    { "desert",                 desert,                  7, 0.62 },
    { "savanna",                savanna,                 8, 0.58 },
    { "savanna_plateau",        savanna_plateau,         9, 0.18 },
    { "badlands",               badlands,               10, 0.12 },
    { "wooded_badlands",        wooded_badlands,        11, 0.08 },
    /* Jungle */
    { "jungle",                 jungle,                 12, 0.28 },
    { "sparse_jungle",          sparse_jungle,          13, 0.22 },
    { "bamboo_jungle",          bamboo_jungle,          14, 0.14 },
    /* Swamp */
    { "swamp",                  swamp,                  15, 0.48 },
    { "mangrove_swamp",         mangrove_swamp,         16, 0.11 },
    /* Cold */
    { "taiga",                  taiga,                  17, 0.72 },
    { "old_growth_pine_taiga",  old_growth_pine_taiga,  18, 0.18 },
    { "old_growth_spruce_taiga",old_growth_spruce_taiga,19, 0.16 },
    { "snowy_plains",           snowy_plains,           20, 0.42 },
    { "snowy_taiga",            snowy_taiga,            21, 0.36 },
    { "ice_spikes",             ice_spikes,             22, 0.05 },
    /* Mountains */
    { "meadow",                 meadow,                 23, 0.34 },
    { "grove",                  grove,                  24, 0.22 },
    { "snowy_slopes",           snowy_slopes,           25, 0.16 },
    { "jagged_peaks",           jagged_peaks,           26, 0.12 },
    { "frozen_peaks",           frozen_peaks,           27, 0.07 },
    { "stony_peaks",            stony_peaks,            28, 0.18 },
    /* Ocean */
    { "ocean",                  ocean,                  29, 0.84 },
    { "warm_ocean",             warm_ocean,             30, 0.34 },
    { "frozen_ocean",           frozen_ocean,           31, 0.28 },
    /* Rare / prized */
    { "mushroom_fields",        mushroom_fields,        32, 0.012 },
    { "cherry_grove",           cherry_grove,           33, 0.018 },
    { "deep_dark",              deep_dark,              34, 0.06 },
    { "lush_caves",             lush_caves,             35, 0.08 },
    { "dripstone_caves",        dripstone_caves,        36, 0.18 },
    { "pale_garden",            pale_garden,            37, 0.014 },
};
const size_t BIOMES_LEN = sizeof(BIOMES) / sizeof(BIOMES[0]);

const StructRow STRUCTS[] = {
    /* Common */
    { "village",          Village,         0,  0.74 },
    { "pillager_outpost", Outpost,         1,  0.42 },
    { "ruined_portal",    Ruined_Portal,   2,  0.82 },
    { "shipwreck",        Shipwreck,       3,  0.46 },
    { "buried_treasure",  Treasure,        4,  0.62 },
    /* Biome-locked */
    { "swamp_hut",        Swamp_Hut,       5,  0.18 },
    { "igloo",            Igloo,           6,  0.22 },
    { "desert_pyramid",   Desert_Pyramid,  7,  0.28 },
    { "jungle_temple",    Jungle_Temple,   8,  0.14 },
    { "ocean_monument",   Monument,        9,  0.16 },
    { "ocean_ruin",       Ocean_Ruin,     10,  0.34 },
    /* Rare / premium */
    { "mansion",          Mansion,        11,  0.022 },
    { "ancient_city",     Ancient_City,   12,  0.038 },
    { "trail_ruins",      Trail_Ruins,    13,  0.082 },
    { "trial_chambers",   Trial_Chambers, 14,  0.058 },
    { "mineshaft",        Mineshaft,      15,  0.94 },
    /* "stronghold" handled by initFirstStronghold / nextStronghold instead. */
};
const size_t STRUCTS_LEN = sizeof(STRUCTS) / sizeof(STRUCTS[0]);

const BiomeRow *lookup_biome(const char *id) {
    for (size_t i = 0; i < BIOMES_LEN; i++) {
        if (strcmp(BIOMES[i].id, id) == 0) return &BIOMES[i];
    }
    return NULL;
}

const StructRow *lookup_structure(const char *id) {
    for (size_t i = 0; i < STRUCTS_LEN; i++) {
        if (strcmp(STRUCTS[i].id, id) == 0) return &STRUCTS[i];
    }
    return NULL;
}

int lookup_mc_version(const char *id) {
    if (strcmp(id, "1.21") == 0) return MC_1_21;
    if (strcmp(id, "1.20") == 0) return MC_1_20;
    if (strcmp(id, "1.19") == 0) return MC_1_19;
    if (strcmp(id, "1.18") == 0) return MC_1_18;
    return -1;
}

uint64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)ts.tv_nsec / 1000000ULL;
}

uint64_t mix64(uint64_t x) {
    /* SplitMix64 */
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}
