/*
 * seed_precompute — batch cache builder.
 *
 * Usage:
 *   seed_precompute <mc> <large_biomes> <count> <start_seed> [threads]
 *
 * Emits one JSON line per seed to stdout:
 *   {"seed":...,"mc":"1.21","large":0,
 *    "biome_mask_100":...,"struct_mask_100":...,
 *    "biome_mask_200":..., ...}
 *
 * The bot ingests this output into the `seed_cache` table.
 *
 * All four bucket radii (100, 200, 500, 1000) are computed in one pass so the
 * cost amortises across the radii: the same generator state is reused, and
 * larger-radius scans extend rather than duplicate smaller-radius ones.
 */

#define _POSIX_C_SOURCE 200809L

#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "finders.h"
#include "generator.h"

#include "search.h"
#include "util.h"

static const int RADII[] = { 100, 200, 500, 1000 };

typedef struct {
    int mc;
    bool large;
    uint64_t start_seed;
    uint64_t count;
    int thread_id;
    int n_threads;
    pthread_mutex_t *out_mutex;
} PreCtx;

static void *precompute_thread(void *arg) {
    PreCtx *ctx = (PreCtx *)arg;

    for (uint64_t i = 0; i < ctx->count; i++) {
        uint64_t raw = ctx->start_seed + (uint64_t)ctx->thread_id +
                       i * (uint64_t)ctx->n_threads;
        uint64_t seed = mix64(raw);

        uint64_t bm[4] = {0}, sm[4] = {0};
        for (int r = 0; r < 4; r++) {
            search_full_scan(ctx->mc, ctx->large, seed, RADII[r],
                             &bm[r], &sm[r]);
        }

        pthread_mutex_lock(ctx->out_mutex);
        printf("{\"seed\":\"%lld\",\"mc\":\"%s\",\"large\":%d,"
               "\"biome_mask_100\":\"%llu\",\"struct_mask_100\":\"%llu\","
               "\"biome_mask_200\":\"%llu\",\"struct_mask_200\":\"%llu\","
               "\"biome_mask_500\":\"%llu\",\"struct_mask_500\":\"%llu\","
               "\"biome_mask_1000\":\"%llu\",\"struct_mask_1000\":\"%llu\"}\n",
               (long long)seed,
               ctx->mc == MC_1_21 ? "1.21" : "1.20",
               ctx->large ? 1 : 0,
               (unsigned long long)bm[0], (unsigned long long)sm[0],
               (unsigned long long)bm[1], (unsigned long long)sm[1],
               (unsigned long long)bm[2], (unsigned long long)sm[2],
               (unsigned long long)bm[3], (unsigned long long)sm[3]);
        fflush(stdout);
        pthread_mutex_unlock(ctx->out_mutex);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr,
                "Usage: %s <mc:1.20|1.21> <large:0|1> <count> <start_seed> [threads]\n",
                argv[0]);
        return 1;
    }
    int mc = lookup_mc_version(argv[1]);
    if (mc < 0) { fprintf(stderr, "bad mc\n"); return 1; }
    bool large = atoi(argv[2]) != 0;
    uint64_t count = strtoull(argv[3], NULL, 10);
    uint64_t start = (uint64_t)strtoll(argv[4], NULL, 10);
    int n_threads = argc > 5 ? atoi(argv[5]) : 0;
    if (n_threads <= 0) {
        long n = sysconf(_SC_NPROCESSORS_ONLN);
        n_threads = n > 0 ? (int)n : 2;
    }

    setvbuf(stdout, NULL, _IOLBF, 0);

    pthread_mutex_t out_mutex = PTHREAD_MUTEX_INITIALIZER;
    pthread_t *threads = calloc((size_t)n_threads, sizeof(pthread_t));
    PreCtx *ctxs = calloc((size_t)n_threads, sizeof(PreCtx));
    if (!threads || !ctxs) return 1;

    uint64_t per_thread = (count + (uint64_t)n_threads - 1) / (uint64_t)n_threads;
    for (int t = 0; t < n_threads; t++) {
        ctxs[t].mc = mc;
        ctxs[t].large = large;
        ctxs[t].start_seed = start;
        ctxs[t].count = per_thread;
        ctxs[t].thread_id = t;
        ctxs[t].n_threads = n_threads;
        ctxs[t].out_mutex = &out_mutex;
        pthread_create(&threads[t], NULL, precompute_thread, &ctxs[t]);
    }
    for (int t = 0; t < n_threads; t++) pthread_join(threads[t], NULL);
    free(threads);
    free(ctxs);
    return 0;
}
