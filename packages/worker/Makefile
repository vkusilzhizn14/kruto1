# Builds the kruto52 C worker.
#
# Targets:
#   release        — default, optimized build with -O3 -fwrapv (portable)
#   native         — release + -march=native + -flto. NO -ffast-math, so
#                    floating-point biome/climate results stay bit-exact
#                    with release. Safe to deploy when build host == prod
#                    host (~+15–20% throughput on modern CPUs).
#   debug          — -O0 -ggdb3 + ASan
#   smoke          — parity test: builds release + native side-by-side and
#                    diffs the seed_enrich JSON for a fixed set of seeds.
#                    Aborts non-zero if any output differs.
#   clean          — remove build artefacts
#
# Outputs:
#   seed_worker         — interactive worker (reads JSON from stdin, streams JSON to stdout)
#   seed_precompute     — batch tool that emits seed metadata CSV/JSON for the DB
#   seed_enrich         — single-seed full bitmask enrichment tool

CC      ?= cc
CFLAGS  ?= -O3 -fwrapv -Wall -Wextra -Wno-unused-parameter -Wno-sign-compare
LDFLAGS ?= -lm -lpthread

CUBIOMES_DIR := cubiomes
CUBIOMES_LIB := $(CUBIOMES_DIR)/libcubiomes.a

INCLUDES := -I$(CUBIOMES_DIR) -Isrc

SRC := src/main.c src/json.c src/search.c src/util.c src/precompute.c src/enrich.c
OBJ := $(SRC:.c=.o)

WORKER_OBJ := src/main.o src/json.o src/search.o src/util.o
PRECOMPUTE_OBJ := src/precompute.o src/json.o src/search.o src/util.o
ENRICH_OBJ := src/enrich.o src/search.o src/util.o

.PHONY: all release native debug smoke clean cubiomes

all: release

release: CFLAGS += -O3 -fPIC
release: seed_worker seed_precompute seed_enrich

# Native build is intentionally WITHOUT -ffast-math: cubiomes climate
# noise is sensitive to reassociation and would silently shift biome
# boundaries, making cached bitmasks disagree with new live searches.
# -march=native + -flto alone gives the bulk of the win on a modern CPU.
native: CFLAGS += -O3 -march=native -flto -fPIC
native: LDFLAGS += -flto
native: seed_worker seed_precompute seed_enrich

debug: CFLAGS := -O0 -ggdb3 -fwrapv -Wall -Wextra -Wno-unused-parameter -Wno-sign-compare -fsanitize=address
debug: LDFLAGS += -fsanitize=address
debug: seed_worker seed_precompute seed_enrich

cubiomes: $(CUBIOMES_LIB)

$(CUBIOMES_LIB):
	@echo "  CUBIOMES BUILD"
	$(MAKE) -C $(CUBIOMES_DIR) release

src/%.o: src/%.c | $(CUBIOMES_LIB)
	$(CC) -c $(CFLAGS) $(INCLUDES) $< -o $@

seed_worker: $(WORKER_OBJ) $(CUBIOMES_LIB)
	$(CC) $(WORKER_OBJ) $(CUBIOMES_LIB) -o $@ $(LDFLAGS)

seed_precompute: $(PRECOMPUTE_OBJ) $(CUBIOMES_LIB)
	$(CC) $(PRECOMPUTE_OBJ) $(CUBIOMES_LIB) -o $@ $(LDFLAGS)

seed_enrich: $(ENRICH_OBJ) $(CUBIOMES_LIB)
	$(CC) $(ENRICH_OBJ) $(CUBIOMES_LIB) -o $@ $(LDFLAGS)

clean:
	rm -f src/*.o seed_worker seed_precompute seed_enrich
	$(MAKE) -C $(CUBIOMES_DIR) clean

# Parity smoke test: builds release + native side-by-side and verifies
# they produce byte-identical seed_enrich output for a fixed seed set.
# Any drift here means the native build has changed cubiomes semantics
# (typically because someone added -ffast-math) and MUST NOT be deployed.
smoke:
	@./smoke_test.sh
