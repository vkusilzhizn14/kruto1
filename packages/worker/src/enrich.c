/*
 * seed_enrich — compute full bitmask for a single known seed.
 *
 * Usage:
 *   seed_enrich <mc:1.20|1.21> <large:0|1> <seed>
 *
 * Outputs one JSON line to stdout (same format as seed_precompute).
 * Used by the bot to promote a live-search result into a universal
 * seed_cache row with all biome/structure bits across all radii.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "finders.h"
#include "generator.h"

#include "search.h"
#include "util.h"

static const int RADII[] = {100, 200, 500, 1000};

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "Usage: %s <mc:1.20|1.21> <large:0|1> <seed>\n",
                argv[0]);
        return 1;
    }
    int mc = lookup_mc_version(argv[1]);
    if (mc < 0) {
        fprintf(stderr, "bad mc\n");
        return 1;
    }
    bool large = atoi(argv[2]) != 0;
    uint64_t seed = (uint64_t)strtoll(argv[3], NULL, 10);

    uint64_t bm[4] = {0}, sm[4] = {0};
    for (int r = 0; r < 4; r++)
        search_full_scan(mc, large, seed, RADII[r], &bm[r], &sm[r]);

    printf("{\"seed\":\"%lld\",\"mc\":\"%s\",\"large\":%d,"
           "\"biome_mask_100\":\"%llu\",\"struct_mask_100\":\"%llu\","
           "\"biome_mask_200\":\"%llu\",\"struct_mask_200\":\"%llu\","
           "\"biome_mask_500\":\"%llu\",\"struct_mask_500\":\"%llu\","
           "\"biome_mask_1000\":\"%llu\",\"struct_mask_1000\":\"%llu\"}\n",
           (long long)seed,
           mc == MC_1_21 ? "1.21" : "1.20",
           large ? 1 : 0,
           (unsigned long long)bm[0], (unsigned long long)sm[0],
           (unsigned long long)bm[1], (unsigned long long)sm[1],
           (unsigned long long)bm[2], (unsigned long long)sm[2],
           (unsigned long long)bm[3], (unsigned long long)sm[3]);
    return 0;
}
