/*
 * seed_worker — interactive search worker.
 *
 * Reads one line of JSON from stdin describing the search request, runs the
 * multi-threaded search, and streams progress + result lines to stdout. The
 * worker exits after emitting the terminal message (result / not_found /
 * cancelled / error).
 *
 * Cancellation is signalled by sending SIGTERM to the worker. The signal
 * handler flips an atomic flag observed by all worker threads, which exit at
 * their next check; the main loop emits a `cancelled` line and exits.
 */

#define _POSIX_C_SOURCE 200809L

#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "json.h"
#include "search.h"
#include "util.h"

/* Prototypes from cubiomes/util.h — forward-declared here because the
 * cubiomes file is also named util.h and is shadowed by the worker's
 * src/util.h on the include path. */
extern void initBiomeColors(unsigned char biomeColors[256][3]);
extern int biomesToImage(unsigned char *pixels,
                         unsigned char biomeColors[256][3],
                         const int *biomes,
                         const unsigned int sx, const unsigned int sy,
                         const unsigned int pixscale, const int flip);

#define MAX_INPUT 32768
#define MAX_EXCLUDE 64

typedef struct {
    char id[64];
    char mc[8];
    bool large_biomes;
    int radius;
    int threads;
    uint64_t max_seeds;
    uint64_t timeout_ms;
    uint64_t start_seed;
    uint64_t exclude_seeds[MAX_EXCLUDE];
    size_t n_exclude;
    SearchSpec spec;
} Request;

typedef struct {
    Request *req;
    int *err;
} ArrCtx;

static int collect_biome(const char *id, void *ctxv) {
    ArrCtx *ctx = (ArrCtx *)ctxv;
    const BiomeRow *b = lookup_biome(id);
    if (!b) { *ctx->err = 1; return 1; }
    if (ctx->req->spec.n_biomes >= KR_MAX_BIOMES) return 1;
    ctx->req->spec.biomes[ctx->req->spec.n_biomes++] = b;
    return 0;
}

static int collect_structure(const char *id, void *ctxv) {
    ArrCtx *ctx = (ArrCtx *)ctxv;
    const StructRow *s = lookup_structure(id);
    if (!s) { *ctx->err = 1; return 1; }
    if (ctx->req->spec.n_structures >= KR_MAX_STRUCTURES) return 1;
    ctx->req->spec.structures[ctx->req->spec.n_structures++] = s;
    return 0;
}

static int collect_exclude(const char *id, void *ctxv) {
    ArrCtx *ctx = (ArrCtx *)ctxv;
    if (ctx->req->n_exclude >= MAX_EXCLUDE) return 1;
    char *e;
    long long v = strtoll(id, &e, 10);
    if (e == id) { *ctx->err = 1; return 1; }
    ctx->req->exclude_seeds[ctx->req->n_exclude++] = (uint64_t)v;
    return 0;
}

static int parse_request(const char *json, Request *req) {
    memset(req, 0, sizeof(*req));
    req->threads = 0;
    req->max_seeds = 1000000;
    req->timeout_ms = 60000;
    req->radius = 500;
    search_spec_init(&req->spec);

    const char *p;
    int err = 0;
    ArrCtx ctx = { req, &err };

    if ((p = json_find_key(json, "id"))) json_parse_string(p, req->id, sizeof(req->id));
    if ((p = json_find_key(json, "mc"))) json_parse_string(p, req->mc, sizeof(req->mc));
    if ((p = json_find_key(json, "large_biomes")))
        json_parse_bool(p, &req->large_biomes, NULL);
    if ((p = json_find_key(json, "radius"))) {
        int64_t v; if (json_parse_int64(p, &v, NULL)) req->radius = (int)v;
    }
    if ((p = json_find_key(json, "max_seeds"))) {
        int64_t v; if (json_parse_int64(p, &v, NULL)) req->max_seeds = (uint64_t)v;
    }
    if ((p = json_find_key(json, "timeout_ms"))) {
        int64_t v; if (json_parse_int64(p, &v, NULL)) req->timeout_ms = (uint64_t)v;
    }
    if ((p = json_find_key(json, "threads"))) {
        int64_t v; if (json_parse_int64(p, &v, NULL)) req->threads = (int)v;
    }
    if ((p = json_find_key(json, "start_seed"))) {
        uint64_t v; if (json_parse_uint64(p, &v, NULL)) req->start_seed = v;
    } else {
        /* Random start seed seeded from the request id for reproducibility
         * but uniqueness across runs. */
        uint64_t mix = (uint64_t)now_ms();
        for (const char *c = req->id; *c; c++) mix = mix * 1315423911u + (uint8_t)*c;
        req->start_seed = mix64(mix);
    }
    if ((p = json_find_key(json, "biomes"))) {
        if (json_iter_string_array(p, collect_biome, &ctx) < 0 || err) return -1;
    }
    if ((p = json_find_key(json, "structures"))) {
        if (json_iter_string_array(p, collect_structure, &ctx) < 0 || err) return -1;
    }
    if ((p = json_find_key(json, "exclude_seeds"))) {
        if (json_iter_string_array(p, collect_exclude, &ctx) < 0 || err) return -1;
    }

    req->spec.mc = lookup_mc_version(req->mc);
    req->spec.large_biomes = req->large_biomes;
    req->spec.radius = req->radius;
    search_spec_finalize(&req->spec);

    if (req->spec.mc < 0) return -1;
    if (req->threads <= 0) {
        long n = sysconf(_SC_NPROCESSORS_ONLN);
        req->threads = n > 0 ? (int)n : 2;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Signal handling                                                      */
/* ------------------------------------------------------------------ */

static void on_sigterm(int sig) {
    (void)sig;
    search_cancel_all();
}

/* ------------------------------------------------------------------ */
/* Progress reporter thread                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    const char *req_id;
    _Atomic(uint64_t) *seeds_tested;
    _Atomic(int) *done_flag;
    uint64_t start_ms;
} ProgressCtx;

static void *progress_loop(void *arg) {
    ProgressCtx *ctx = (ProgressCtx *)arg;
    uint64_t last_tested = 0;
    uint64_t last_ms = ctx->start_ms;
    while (!atomic_load(ctx->done_flag)) {
        struct timespec ts = { 0, 500 * 1000 * 1000 }; /* 500ms */
        nanosleep(&ts, NULL);
        if (atomic_load(ctx->done_flag)) break;
        uint64_t tested = atomic_load(ctx->seeds_tested);
        uint64_t now = now_ms();
        uint64_t dt = now > last_ms ? now - last_ms : 1;
        uint64_t rate = (tested - last_tested) * 1000ULL / dt;
        printf("{\"id\":\"%s\",\"type\":\"progress\",\"seeds_tested\":%llu,"
               "\"seeds_per_sec\":%llu,\"elapsed_ms\":%llu}\n",
               ctx->req_id,
               (unsigned long long)tested,
               (unsigned long long)rate,
               (unsigned long long)(now - ctx->start_ms));
        fflush(stdout);
        last_tested = tested;
        last_ms = now;
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Emit result lines                                                    */
/* ------------------------------------------------------------------ */

static const char *biome_id_from_bit(int bit) {
    for (size_t i = 0; i < BIOMES_LEN; i++)
        if (BIOMES[i].bit == bit) return BIOMES[i].id;
    return "?";
}

static const char *struct_id_from_bit(int bit) {
    for (size_t i = 0; i < STRUCTS_LEN; i++)
        if (STRUCTS[i].bit == bit) return STRUCTS[i].id;
    return "?";
}

static void emit_result(const char *req_id, const SearchResult *r,
                        uint64_t seeds_tested, uint64_t elapsed_ms) {
    printf("{\"id\":\"%s\",\"type\":\"result\",\"seed\":\"%lld\","
           "\"spawn\":{\"x\":0,\"z\":0},\"biomes\":[",
           req_id, (long long)r->seed);
    for (int i = 0; i < r->n_biomes; i++) {
        printf("%s{\"id\":\"%s\",\"x\":%d,\"z\":%d}",
               i ? "," : "",
               biome_id_from_bit(r->biomes[i].id_bit),
               r->biomes[i].x, r->biomes[i].z);
    }
    printf("],\"structures\":[");
    for (int i = 0; i < r->n_structures; i++) {
        printf("%s{\"id\":\"%s\",\"x\":%d,\"z\":%d}",
               i ? "," : "",
               struct_id_from_bit(r->structures[i].id_bit),
               r->structures[i].x, r->structures[i].z);
    }
    printf("],\"seeds_tested\":%llu,\"elapsed_ms\":%llu}\n",
           (unsigned long long)seeds_tested,
           (unsigned long long)elapsed_ms);
}

/* ------------------------------------------------------------------ */
/* main                                                                 */
/* ------------------------------------------------------------------ */

static int run_resolve_mode(void) {
    /* Resolve mode: probe a single explicit seed and emit positions for the
     * biomes / structures listed in the request. Used by the bot after a
     * cache hit, where we already know which seed matches but need real
     * coordinates instead of (0,0) placeholders. */
    setvbuf(stdout, NULL, _IOLBF, 0);
    char buf[MAX_INPUT];
    if (!fgets(buf, sizeof(buf), stdin)) {
        fprintf(stderr, "seed_worker: empty stdin (resolve)\n");
        return 1;
    }
    Request req;
    if (parse_request(buf, &req) < 0) {
        printf("{\"id\":\"%s\",\"type\":\"error\",\"message\":\"bad_request\"}\n", req.id);
        return 1;
    }
    const char *p = json_find_key(buf, "seed");
    if (!p) {
        printf("{\"id\":\"%s\",\"type\":\"error\",\"message\":\"missing_seed\"}\n", req.id);
        return 1;
    }
    int64_t seed_i64 = 0;
    char seed_buf[32];
    if (json_parse_string(p, seed_buf, sizeof(seed_buf))) {
        seed_i64 = strtoll(seed_buf, NULL, 10);
    } else if (!json_parse_int64(p, &seed_i64, NULL)) {
        printf("{\"id\":\"%s\",\"type\":\"error\",\"message\":\"bad_seed\"}\n", req.id);
        return 1;
    }
    uint64_t seed = (uint64_t)seed_i64;

    Generator g;
    setupGenerator(&g, req.spec.mc, req.spec.large_biomes ? LARGE_BIOMES : 0);
    SearchResult result;
    int hit = search_probe_seed(&req.spec, &g, seed, &result);
    if (!hit) {
        /* Seed doesn't actually satisfy the spec (cache row stale or
         * radius mismatch). Emit empty result so the bot can degrade
         * gracefully without spinning forever. */
        printf("{\"id\":\"%s\",\"type\":\"result\",\"seed\":\"%lld\","
               "\"spawn\":{\"x\":0,\"z\":0},\"biomes\":[],\"structures\":[],"
               "\"seeds_tested\":0,\"elapsed_ms\":0}\n",
               req.id, (long long)seed_i64);
        return 0;
    }
    emit_result(req.id, &result, 1, 0);
    return 0;
}

static int run_map_mode(void) {
    /* Map mode: emit a top-down PPM image (P6, 24-bit RGB) of the biomes
     * around spawn for a given seed. Output is written to stdout as
     * a single raw image; the bot decodes it and overlays structure
     * pins + spawn marker, then re-encodes as PNG for Telegram.
     *
     * Input JSON (one line on stdin):
     *   {"id":"...","mc":"1.21","seed":"...","radius":256,"size":192,
     *    "large_biomes":false}
     *
     * On error we write the error JSON to STDERR (so it doesn't corrupt
     * the binary stdout) and exit non-zero.
     */
    char buf[MAX_INPUT];
    if (!fgets(buf, sizeof(buf), stdin)) {
        fprintf(stderr, "seed_worker: empty stdin (map)\n");
        return 1;
    }
    /* Parse minimal fields directly (no Request needed). */
    char mc[8] = "1.21";
    bool large_biomes = false;
    int radius = 256;
    int size = 192;
    int64_t seed_i64 = 0;
    {
        const char *p;
        if ((p = json_find_key(buf, "mc"))) {
            json_parse_string(p, mc, sizeof(mc));
        }
        if ((p = json_find_key(buf, "radius"))) {
            int64_t v = 0;
            if (json_parse_int64(p, &v, NULL)) radius = (int)v;
        }
        if ((p = json_find_key(buf, "size"))) {
            int64_t v = 0;
            if (json_parse_int64(p, &v, NULL)) size = (int)v;
        }
        if ((p = json_find_key(buf, "large_biomes"))) {
            bool b = false;
            if (json_parse_bool(p, &b, NULL)) large_biomes = b;
        }
        p = json_find_key(buf, "seed");
        if (!p) {
            fprintf(stderr, "seed_worker: map missing seed\n");
            return 1;
        }
        char seed_buf[32];
        if (json_parse_string(p, seed_buf, sizeof(seed_buf))) {
            seed_i64 = strtoll(seed_buf, NULL, 10);
        } else if (!json_parse_int64(p, &seed_i64, NULL)) {
            fprintf(stderr, "seed_worker: map bad seed\n");
            return 1;
        }
    }
    if (size < 32) size = 32;
    if (size > 1024) size = 1024;
    if (radius < 16) radius = 16;

    /* Resolve cubiomes mc enum from the string. */
    int mc_enum = lookup_mc_version(mc);
    if (mc_enum < 0) {
        fprintf(stderr, "seed_worker: map bad mc %s\n", mc);
        return 1;
    }

    Generator g;
    setupGenerator(&g, mc_enum, large_biomes ? LARGE_BIOMES : 0);
    applySeed(&g, DIM_OVERWORLD, (uint64_t)seed_i64);

    /* Pick the cubiomes scale so the rendered area covers roughly the
     * requested 2*radius blocks. cubiomes supports {1, 4, 16, 64, 256};
     * scale=1 is voronoi (slow, per-block detail), scale>=4 skips it
     * (much faster but blocky). We want the *smallest* scale where
     * size*scale >= 2*radius — that way the requested area always fits
     * but pixels stay as fine as possible. */
    int wanted = 2 * radius;
    int scale;
    if ((int)size * 1 >= wanted) scale = 1;
    else if ((int)size * 4 >= wanted) scale = 4;
    else if ((int)size * 16 >= wanted) scale = 16;
    else if ((int)size * 64 >= wanted) scale = 64;
    else scale = 256;

    int half = size / 2;
    Range r = { scale, -half, -half, size, size, 64, 0 };
    int *cache = allocCache(&g, r);
    if (!cache) {
        fprintf(stderr, "seed_worker: map allocCache failed\n");
        return 1;
    }
    if (genBiomes(&g, cache, r) != 0) {
        fprintf(stderr, "seed_worker: map genBiomes failed\n");
        free(cache);
        return 1;
    }

    unsigned char biomeColors[256][3];
    initBiomeColors(biomeColors);
    unsigned char *pixels = (unsigned char *)malloc((size_t)size * size * 3);
    if (!pixels) {
        free(cache);
        fprintf(stderr, "seed_worker: map malloc pixels failed\n");
        return 1;
    }
    /* flip=1 → image row 0 corresponds to cache row j=0 (most negative z =
     * north). This matches the standard north-up map convention and the
     * bot's worldToPx() projection. With flip=0 the image would be
     * vertically mirrored (south at top), causing pins to land on the
     * wrong side. */
    biomesToImage(pixels, biomeColors, cache,
                  (unsigned int)size, (unsigned int)size, 1, 1);

    /* Write PPM (P6) header + raw RGB to stdout. The bot reads the whole
     * blob then decodes it. */
    fprintf(stdout, "P6\n%d %d\n255\n", size, size);
    fwrite(pixels, 1, (size_t)size * size * 3, stdout);
    fflush(stdout);

    /* Effective radius the caller should use to project pin coords back
     * onto this image (may exceed the requested radius due to scale
     * rounding). Emit on stderr as a single line of JSON so the bot can
     * pick it up without disturbing the PPM stream. */
    int effective_radius = (size * scale) / 2;
    fprintf(stderr, "{\"scale\":%d,\"size\":%d,\"effective_radius\":%d}\n",
            scale, size, effective_radius);
    fflush(stderr);

    free(pixels);
    free(cache);
    return 0;
}

int main(int argc, char **argv) {
    /* Subcommand dispatch: if first arg is "precompute", delegate. */
    if (argc > 1 && strcmp(argv[1], "version") == 0) {
        printf("seed_worker 0.1\n");
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "resolve") == 0) {
        return run_resolve_mode();
    }
    if (argc > 1 && strcmp(argv[1], "map") == 0) {
        return run_map_mode();
    }

    signal(SIGTERM, on_sigterm);
    signal(SIGINT, on_sigterm);

    setvbuf(stdout, NULL, _IOLBF, 0);

    char buf[MAX_INPUT];
    if (!fgets(buf, sizeof(buf), stdin)) {
        fprintf(stderr, "seed_worker: empty stdin\n");
        return 1;
    }

    Request req;
    if (parse_request(buf, &req) < 0) {
        fprintf(stderr, "seed_worker: bad request\n");
        printf("{\"id\":\"%s\",\"type\":\"error\",\"message\":\"bad_request\"}\n", req.id);
        return 1;
    }

    if (req.spec.n_biomes == 0 && req.spec.n_structures == 0) {
        printf("{\"id\":\"%s\",\"type\":\"error\",\"message\":\"empty_criteria\"}\n", req.id);
        return 1;
    }

    _Atomic(uint64_t) seeds_tested = 0;
    _Atomic(int) done = 0;
    pthread_t progress_thread;
    ProgressCtx pctx = { req.id, &seeds_tested, &done, now_ms() };
    pthread_create(&progress_thread, NULL, progress_loop, &pctx);

    /* Run the search synchronously on this thread; worker threads are spun
     * up inside search_run(). progress_thread above only emits progress. */
    SearchResult result;
    uint64_t tested = 0, elapsed = 0;
    int outcome = search_run(&req.spec, req.threads, req.start_seed,
                              req.max_seeds, req.timeout_ms,
                              req.exclude_seeds, req.n_exclude,
                              &result, &tested, &elapsed,
                              &seeds_tested);
    /* `tested` is the final count; `seeds_tested` already mirrored live
     * thread state for the progress reporter throughout the run. */
    atomic_store(&done, 1);
    pthread_join(progress_thread, NULL);

    if (outcome == 1) {
        emit_result(req.id, &result, tested, elapsed);
    } else if (outcome == -1) {
        printf("{\"id\":\"%s\",\"type\":\"cancelled\",\"seeds_tested\":%llu,"
               "\"elapsed_ms\":%llu}\n",
               req.id, (unsigned long long)tested,
               (unsigned long long)elapsed);
    } else {
        const char *reason = elapsed >= req.timeout_ms ? "timeout" : "exhausted";
        printf("{\"id\":\"%s\",\"type\":\"not_found\",\"reason\":\"%s\","
               "\"seeds_tested\":%llu,\"elapsed_ms\":%llu}\n",
               req.id, reason,
               (unsigned long long)tested,
               (unsigned long long)elapsed);
    }
    fflush(stdout);
    return 0;
}
