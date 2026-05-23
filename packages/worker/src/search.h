/*
 * Search engine: given a SearchSpec, find a Minecraft seed where the required
 * biomes and structures all appear within `radius` blocks of (0, 0).
 *
 * Algorithm summary (in order of cost ascending):
 *
 *   0. Structure-position pre-filter.
 *      For every required structure type, `getStructurePos` deterministically
 *      computes (in microseconds) the candidate position in each 512x512
 *      region. We scan all regions intersecting the user's radius and accept
 *      only seeds where each required structure has at least one candidate
 *      within range. This rejects 90%+ of seeds for typical "village + X"
 *      queries with no terrain generation at all.
 *
 *   1. Rarity-ordered biome scan.
 *      For seeds that pass step 0, we apply the seed to a thread-local
 *      generator and scan for the required biomes in order of rarity
 *      ascending (rarest first). Each scan is coarse-to-fine: step=64 blocks
 *      to detect presence, then step=4 around any hit to refine the
 *      coordinate. The rarest filter rejects most failures with the cheapest
 *      scan.
 *
 *   2. Structure terrain verification.
 *      Finally, `isViableStructurePos` confirms terrain at each chosen
 *      structure candidate (uses biome generation, slow but only run on
 *      surviving seeds).
 *
 * Threads:
 *   Multiple worker threads share the SearchSpec and an atomic cancel /
 *   found flag. Each thread iterates a disjoint slice of seed space; the
 *   first to find a match flips `found` and signals the main thread.
 */

#ifndef KR_SEARCH_H
#define KR_SEARCH_H

#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

#include "finders.h"

#include "util.h"

#define KR_MAX_BIOMES     16
#define KR_MAX_STRUCTURES 16
#define KR_MAX_CANDIDATES 32

typedef struct {
    int mc;                                /* MC_1_21 etc. */
    bool large_biomes;
    int radius;                            /* blocks */
    int n_biomes;
    int n_structures;
    const BiomeRow  *biomes[KR_MAX_BIOMES];
    const StructRow *structures[KR_MAX_STRUCTURES];
    /* Cached sorted order: biome_order[i] indexes into biomes[]; lowest rarity first. */
    int biome_order[KR_MAX_BIOMES];
    int struct_order[KR_MAX_STRUCTURES];
} SearchSpec;

void search_spec_init(SearchSpec *spec);
void search_spec_finalize(SearchSpec *spec);

typedef struct {
    int id_bit;
    int x;
    int z;
} FoundPos;

typedef struct {
    uint64_t seed;
    FoundPos biomes[KR_MAX_BIOMES];
    int n_biomes;
    FoundPos structures[KR_MAX_STRUCTURES];
    int n_structures;
} SearchResult;

/* Per-thread state passed to `run_thread`. */
typedef struct {
    const SearchSpec *spec;
    Generator g;
    int thread_id;
    int n_threads;
    uint64_t start_seed;
    uint64_t stride;
    uint64_t max_seeds;
    const uint64_t *exclude_seeds;
    size_t n_exclude;
    _Atomic(int) *cancel_flag;
    _Atomic(int) *found_flag;
    _Atomic(int) *threads_active;
    _Atomic(uint64_t) *seeds_tested_total;
    /* Output (written by winning thread only). */
    pthread_mutex_t *result_mutex;
    SearchResult *result;
} ThreadCtx;

/* Run the search on `n_threads`. Returns 1 if a result was written into
 * `*result`, 0 on exhaustion / timeout, -1 on cancellation. Writes
 * `*seeds_tested` and `*elapsed_ms` regardless. If
 * `live_seeds_tested` is non-NULL, worker threads accumulate into it in
 * real time so an external progress reporter can observe rate without
 * waiting for the search to finish. */
int search_run(const SearchSpec *spec, int n_threads, uint64_t start_seed,
               uint64_t max_seeds, uint64_t timeout_ms,
               const uint64_t *exclude_seeds, size_t n_exclude,
               SearchResult *result, uint64_t *seeds_tested,
               uint64_t *elapsed_ms,
               _Atomic(uint64_t) *live_seeds_tested);

/* Probe a single seed for the spec; on success fills `*result` and returns 1.
 * Exposed for the precompute tool. */
int search_probe_seed(const SearchSpec *spec, Generator *g, uint64_t seed,
                      SearchResult *result);

/* Test a single seed for a list of biomes/structures and fill 64-bit masks
 * of which were found within `radius`. Used by precompute to populate the
 * seed cache table. `out_struct_positions` and `out_biome_positions` may be
 * NULL if positions are not needed. */
void search_full_scan(int mc, bool large_biomes, uint64_t seed, int radius,
                      uint64_t *biome_mask_out, uint64_t *struct_mask_out);

/* Request a co-operative cancel of in-flight search threads. */
void search_cancel_all(void);

#endif /* KR_SEARCH_H */
