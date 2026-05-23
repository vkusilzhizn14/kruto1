#define _GNU_SOURCE
#include "search.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "generator.h"

/* ------------------------------------------------------------------ */
/* Spec helpers                                                        */
/* ------------------------------------------------------------------ */

static int cmp_biome_rarity(const void *a, const void *b, void *ctx) {
    const SearchSpec *spec = (const SearchSpec *)ctx;
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    double ra = spec->biomes[ia]->rarity;
    double rb = spec->biomes[ib]->rarity;
    if (ra < rb) return -1;
    if (ra > rb) return 1;
    return 0;
}

static int cmp_struct_rarity(const void *a, const void *b, void *ctx) {
    const SearchSpec *spec = (const SearchSpec *)ctx;
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    double ra = spec->structures[ia]->rarity;
    double rb = spec->structures[ib]->rarity;
    if (ra < rb) return -1;
    if (ra > rb) return 1;
    return 0;
}

void search_spec_init(SearchSpec *spec) {
    memset(spec, 0, sizeof(*spec));
}

void search_spec_finalize(SearchSpec *spec) {
    for (int i = 0; i < spec->n_biomes; i++) spec->biome_order[i] = i;
    for (int i = 0; i < spec->n_structures; i++) spec->struct_order[i] = i;
    qsort_r(spec->biome_order, spec->n_biomes, sizeof(int),
            cmp_biome_rarity, spec);
    qsort_r(spec->struct_order, spec->n_structures, sizeof(int),
            cmp_struct_rarity, spec);
}

/* ------------------------------------------------------------------ */
/* Global cancel signal                                                */
/* ------------------------------------------------------------------ */

static _Atomic(int) g_cancel = 0;

void search_cancel_all(void) {
    atomic_store(&g_cancel, 1);
}

/* ------------------------------------------------------------------ */
/* Core probe routines                                                  */
/* ------------------------------------------------------------------ */

static inline int sq_in_radius(int x, int z, int radius) {
    return (long long)x * x + (long long)z * z <= (long long)radius * radius;
}

/* Coarse-to-fine biome scan around (0,0) within `radius` blocks.
 * Returns 1 if found and fills (*x_out, *z_out); 0 otherwise.
 *
 * The coarse step adapts to the radius — small biome patches (e.g.
 * flower_forest, ~30 blocks wide) would be missed by a fixed 64-block
 * grid at radius 100, where only ~8 sample points land in the circle.
 * For r <= 128 we step every 16 blocks (≈ biome cell size at scale=4),
 * for r <= 512 every 32, otherwise 64.
 *
 * Implementation note: `getBiomeAt` allocates and frees a 1-cell cache
 * on every call (via `allocCache`/`free`). At ~130 coarse points per
 * biome that's a measurable chunk of work for a function that just
 * needs one int. We skip the allocator round-trip by issuing the same
 * `genBiomes` call ourselves with a single stack-resident output cell
 * and a Range pre-initialized outside the loop. */
static int scan_biome(const Generator *g, int target_biome, int radius,
                      int *x_out, int *z_out) {
    int coarse = (radius <= 128) ? 16 : (radius <= 512) ? 32 : 64;
    int fine_window = coarse / 2;

    Range coarse_r;
    memset(&coarse_r, 0, sizeof(coarse_r));
    coarse_r.scale = 4;
    coarse_r.sx = 1;
    coarse_r.sz = 1;
    coarse_r.y = coarse >> 2;
    coarse_r.sy = 1;

    for (int z = -radius; z <= radius; z += coarse) {
        for (int x = -radius; x <= radius; x += coarse) {
            if (!sq_in_radius(x, z, radius)) continue;
            int cell;
            coarse_r.x = x >> 2;
            coarse_r.z = z >> 2;
            if (genBiomes(g, &cell, coarse_r) != 0) continue;
            int b = cell;
            if (b == target_biome) {
                /* Fine scan around the hit. */
                for (int dz = -fine_window; dz <= fine_window; dz += 8) {
                    for (int dx = -fine_window; dx <= fine_window; dx += 8) {
                        int nx = x + dx, nz = z + dz;
                        if (!sq_in_radius(nx, nz, radius)) continue;
                        int bb = getBiomeAt(g, 1, nx, 63, nz);
                        if (bb == target_biome) {
                            *x_out = nx;
                            *z_out = nz;
                            return 1;
                        }
                    }
                }
                /* Coarse hit but fine scan missed — still return coarse pos. */
                *x_out = x;
                *z_out = z;
                return 1;
            }
        }
    }
    return 0;
}

int search_probe_seed(const SearchSpec *spec, Generator *g, uint64_t seed,
                      SearchResult *result) {
    int radius = spec->radius;
    int region_min = -((radius + 511) / 512);
    int region_max = (radius + 511) / 512;

    /* --- Step 0: structure-position pre-filter (rarest first). --- */
    Pos chosen[KR_MAX_STRUCTURES];
    int candidates[KR_MAX_STRUCTURES][KR_MAX_CANDIDATES];
    Pos candidate_pos[KR_MAX_STRUCTURES][KR_MAX_CANDIDATES];
    int n_cand[KR_MAX_STRUCTURES] = {0};

    for (int oi = 0; oi < spec->n_structures; oi++) {
        int i = spec->struct_order[oi];
        const StructRow *s = spec->structures[i];
        int found_any = 0;
        for (int rx = region_min; rx <= region_max; rx++) {
            for (int rz = region_min; rz <= region_max; rz++) {
                Pos p;
                if (!getStructurePos(s->cubiomes_type, spec->mc, seed, rx, rz, &p))
                    continue;
                if (!sq_in_radius(p.x, p.z, radius)) continue;
                if (n_cand[i] < KR_MAX_CANDIDATES) {
                    candidate_pos[i][n_cand[i]] = p;
                    candidates[i][n_cand[i]] = 1;
                    n_cand[i]++;
                }
                found_any = 1;
            }
        }
        if (!found_any) return 0;
    }

    /* --- Step 1: rarity-ordered biome scan. --- */
    applySeed(g, DIM_OVERWORLD, seed);
    FoundPos biome_results[KR_MAX_BIOMES];
    for (int oi = 0; oi < spec->n_biomes; oi++) {
        int i = spec->biome_order[oi];
        const BiomeRow *b = spec->biomes[i];
        int x = 0, z = 0;
        if (!scan_biome(g, b->cubiomes_id, radius, &x, &z)) return 0;
        biome_results[i].id_bit = b->bit;
        biome_results[i].x = x;
        biome_results[i].z = z;
    }

    /* --- Step 2: structure terrain verification. --- */
    for (int oi = 0; oi < spec->n_structures; oi++) {
        int i = spec->struct_order[oi];
        const StructRow *s = spec->structures[i];
        int verified = 0;
        for (int j = 0; j < n_cand[i]; j++) {
            (void)candidates;
            Pos p = candidate_pos[i][j];
            if (isViableStructurePos(s->cubiomes_type, g, p.x, p.z, 0)) {
                chosen[i] = p;
                verified = 1;
                break;
            }
        }
        if (!verified) return 0;
    }

    /* --- Success: populate result. --- */
    result->seed = seed;
    result->n_biomes = spec->n_biomes;
    result->n_structures = spec->n_structures;
    for (int i = 0; i < spec->n_biomes; i++) {
        result->biomes[i] = biome_results[i];
    }
    for (int i = 0; i < spec->n_structures; i++) {
        result->structures[i].id_bit = spec->structures[i]->bit;
        result->structures[i].x = chosen[i].x;
        result->structures[i].z = chosen[i].z;
    }
    return 1;
}

void search_full_scan(int mc, bool large_biomes, uint64_t seed, int radius,
                      uint64_t *biome_mask_out, uint64_t *struct_mask_out) {
    Generator g;
    setupGenerator(&g, mc, large_biomes ? LARGE_BIOMES : 0);
    applySeed(&g, DIM_OVERWORLD, seed);

    uint64_t bm = 0, sm = 0;
    int region_min = -((radius + 511) / 512);
    int region_max = (radius + 511) / 512;

    /* Structures. */
    for (size_t i = 0; i < STRUCTS_LEN; i++) {
        const StructRow *s = &STRUCTS[i];
        for (int rx = region_min; rx <= region_max; rx++) {
            for (int rz = region_min; rz <= region_max; rz++) {
                Pos p;
                if (!getStructurePos(s->cubiomes_type, mc, seed, rx, rz, &p))
                    continue;
                if (!sq_in_radius(p.x, p.z, radius)) continue;
                if (isViableStructurePos(s->cubiomes_type, &g, p.x, p.z, 0)) {
                    sm |= 1ULL << s->bit;
                    goto next_structure;
                }
            }
        }
        next_structure:;
    }

    /* Biomes: single coarse-grid sweep populates the mask for every
     * catalog biome at once. Previously we ran one full grid scan per
     * catalog biome (BIOMES_LEN ≈ 38 scans), redoing the same noise
     * work each time. Now the noise is computed exactly once per cell. */
    int coarse = (radius <= 128) ? 16 : (radius <= 512) ? 32 : 64;

    Range coarse_r;
    memset(&coarse_r, 0, sizeof(coarse_r));
    coarse_r.scale = 4;
    coarse_r.sx = 1;
    coarse_r.sz = 1;
    coarse_r.y = coarse >> 2;
    coarse_r.sy = 1;

    /* Bitmask of catalog bits still unset, used to stop early once the
     * whole catalog has been observed within the search region. */
    uint64_t remaining = 0;
    for (size_t i = 0; i < BIOMES_LEN; i++)
        remaining |= 1ULL << BIOMES[i].bit;

    for (int z = -radius; z <= radius && remaining; z += coarse) {
        for (int x = -radius; x <= radius && remaining; x += coarse) {
            if (!sq_in_radius(x, z, radius)) continue;
            int cell;
            coarse_r.x = x >> 2;
            coarse_r.z = z >> 2;
            if (genBiomes(&g, &cell, coarse_r) != 0) continue;
            for (size_t i = 0; i < BIOMES_LEN; i++) {
                if (BIOMES[i].cubiomes_id == cell) {
                    uint64_t mask = 1ULL << BIOMES[i].bit;
                    if (remaining & mask) {
                        bm |= mask;
                        remaining &= ~mask;
                    }
                    break;
                }
            }
        }
    }

    *biome_mask_out = bm;
    *struct_mask_out = sm;
}

/* ------------------------------------------------------------------ */
/* Worker threads                                                       */
/* ------------------------------------------------------------------ */

static void *run_thread(void *arg) {
    ThreadCtx *ctx = (ThreadCtx *)arg;
    const SearchSpec *spec = ctx->spec;
    SearchResult local;
    uint64_t tested_local = 0;

    /* threads_active is pre-loaded with n_threads by the caller, so we
     * never observe it as 0 prematurely before any thread has been
     * scheduled. We just decrement on exit. */

    for (uint64_t i = 0; i < ctx->max_seeds; i++) {
        if (atomic_load_explicit(ctx->cancel_flag, memory_order_relaxed) ||
            atomic_load_explicit(ctx->found_flag, memory_order_relaxed) ||
            atomic_load_explicit(&g_cancel, memory_order_relaxed))
            break;

        uint64_t seed = ctx->start_seed + (uint64_t)ctx->thread_id +
                        i * (uint64_t)ctx->n_threads;
        seed = mix64(seed);  /* spread across seed space */

        /* Skip excluded seeds (linear scan; n_exclude is small). */
        bool excluded = false;
        for (size_t k = 0; k < ctx->n_exclude; k++) {
            if (ctx->exclude_seeds[k] == seed) { excluded = true; break; }
        }
        if (excluded) continue;

        if (search_probe_seed(spec, &ctx->g, seed, &local)) {
            int expected = 0;
            if (atomic_compare_exchange_strong(ctx->found_flag, &expected, 1)) {
                pthread_mutex_lock(ctx->result_mutex);
                *ctx->result = local;
                pthread_mutex_unlock(ctx->result_mutex);
            }
            tested_local++;
            atomic_fetch_add_explicit(ctx->seeds_tested_total, tested_local,
                                      memory_order_relaxed);
            atomic_fetch_sub_explicit(ctx->threads_active, 1, memory_order_relaxed);
            return NULL;
        }
        tested_local++;

        /* Flush often so the UI progress counter reflects real-time work. */
        if ((tested_local & 0x3Fu) == 0u) {
            atomic_fetch_add_explicit(ctx->seeds_tested_total, tested_local,
                                      memory_order_relaxed);
            tested_local = 0;
        }
    }
    atomic_fetch_add_explicit(ctx->seeds_tested_total, tested_local,
                              memory_order_relaxed);
    atomic_fetch_sub_explicit(ctx->threads_active, 1, memory_order_relaxed);
    return NULL;
}

int search_run(const SearchSpec *spec, int n_threads, uint64_t start_seed,
               uint64_t max_seeds, uint64_t timeout_ms,
               const uint64_t *exclude_seeds, size_t n_exclude,
               SearchResult *result, uint64_t *seeds_tested,
               uint64_t *elapsed_ms,
               _Atomic(uint64_t) *live_seeds_tested) {
    atomic_store(&g_cancel, 0);
    _Atomic(int) cancel_flag = 0;
    _Atomic(int) found_flag = 0;
    _Atomic(int) threads_active = 0;
    _Atomic(uint64_t) local_tested_total = 0;
    /* Worker threads add into this atomic. If the caller supplied a live
     * counter (the progress thread reads it), use that — otherwise use a
     * private one and copy the final value out below. */
    _Atomic(uint64_t) *tested_total = live_seeds_tested
                                          ? live_seeds_tested
                                          : &local_tested_total;
    pthread_mutex_t result_mutex = PTHREAD_MUTEX_INITIALIZER;

    if (n_threads < 1) n_threads = 1;
    if (n_threads > 64) n_threads = 64;

    ThreadCtx *ctxs = (ThreadCtx *)calloc((size_t)n_threads, sizeof(ThreadCtx));
    pthread_t *threads = (pthread_t *)calloc((size_t)n_threads, sizeof(pthread_t));
    if (!ctxs || !threads) {
        free(ctxs); free(threads);
        return 0;
    }

    uint64_t per_thread = (max_seeds + (uint64_t)n_threads - 1) /
                          (uint64_t)n_threads;
    uint64_t t_start = now_ms();

    /* Pre-set so the main poll loop doesn't read 0 before any thread is
     * scheduled. Threads decrement this on exit. */
    atomic_store(&threads_active, n_threads);

    for (int t = 0; t < n_threads; t++) {
        ctxs[t].spec = spec;
        setupGenerator(&ctxs[t].g, spec->mc,
                       spec->large_biomes ? LARGE_BIOMES : 0);
        ctxs[t].thread_id = t;
        ctxs[t].n_threads = n_threads;
        ctxs[t].start_seed = start_seed;
        ctxs[t].stride = (uint64_t)n_threads;
        ctxs[t].max_seeds = per_thread;
        ctxs[t].exclude_seeds = exclude_seeds;
        ctxs[t].n_exclude = n_exclude;
        ctxs[t].cancel_flag = &cancel_flag;
        ctxs[t].found_flag = &found_flag;
        ctxs[t].threads_active = &threads_active;
        ctxs[t].seeds_tested_total = tested_total;
        ctxs[t].result_mutex = &result_mutex;
        ctxs[t].result = result;
        pthread_create(&threads[t], NULL, run_thread, &ctxs[t]);
    }

    /* Poll for completion / timeout. Exits as soon as either: a thread
     * found a match, all threads exhausted their slice, a cancel was
     * signalled, or the timeout fired. The previous version waited for
     * the full timeout even when all threads had already exited, which
     * made the UI show "0 сид/с" for the entire idle remainder. */
    int outcome = 0; /* 0=not found, 1=found, -1=cancelled */
    while (1) {
        uint64_t elapsed = now_ms() - t_start;
        if (atomic_load(&found_flag)) { outcome = 1; break; }
        if (atomic_load(&g_cancel)) {
            atomic_store(&cancel_flag, 1);
            outcome = -1;
            break;
        }
        if (atomic_load(&threads_active) == 0) {
            outcome = 0;  /* all threads done without finding -> exhausted */
            break;
        }
        if (elapsed >= timeout_ms) {
            atomic_store(&cancel_flag, 1);
            outcome = 0;
            break;
        }
        struct timespec ts = { 0, 50 * 1000 * 1000 }; /* 50ms */
        nanosleep(&ts, NULL);
    }

    for (int t = 0; t < n_threads; t++) pthread_join(threads[t], NULL);

    *seeds_tested = atomic_load(tested_total);
    *elapsed_ms = now_ms() - t_start;

    free(ctxs);
    free(threads);
    return outcome;
}
