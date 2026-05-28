#!/usr/bin/env bash
# Parity smoke test for the worker.
#
# Why this exists:
#   The `native` Makefile target enables -march=native + -flto on the
#   build host. These are safe to deploy ONLY if the resulting binary
#   produces bit-identical output to the portable `release` build for
#   every seed/version pair — otherwise cached bitmasks in seed_cache
#   would silently disagree with new live searches and users would see
#   "found in cache" results pointing at the wrong coordinates.
#
# What it does:
#   1. Builds `release` → copies to seed_enrich.release.
#   2. Builds `native`  → copies to seed_enrich.native.
#   3. Runs both binaries against a small set of well-known seeds at
#      mc 1.21 (no large biomes) and diffs the JSON output line-by-line.
#   4. Exits non-zero on any mismatch.
#
# Intended usage:
#   make smoke         # standalone, before promoting the native binary.
#   CI smoke step      # see .github/workflows/ci.yml — runs the same.
#
# Add or change a seed by editing TEST_SEEDS below. Keep the list small
# (≤ 5) — each invocation walks the full bitmask, which is non-trivial.

set -euo pipefail

cd "$(dirname "$0")"

TEST_SEEDS=(
  "1"          # canonical zero-ish
  "42"         # ubiquitous
  "12345"      # small positive
  "1234567890" # large positive
)
MC="1.21"
LARGE_BIOMES="0"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=== building release binary ==="
make -s clean
make -s release
cp seed_enrich "$TMP_DIR/seed_enrich.release"

echo "=== building native binary ==="
make -s clean
make -s native
cp seed_enrich "$TMP_DIR/seed_enrich.native"

echo "=== diffing outputs ==="
mismatches=0
for seed in "${TEST_SEEDS[@]}"; do
  rel_out=$("$TMP_DIR/seed_enrich.release" "$MC" "$LARGE_BIOMES" "$seed")
  nat_out=$("$TMP_DIR/seed_enrich.native"  "$MC" "$LARGE_BIOMES" "$seed")
  if [[ "$rel_out" != "$nat_out" ]]; then
    echo "MISMATCH for seed=$seed mc=$MC large=$LARGE_BIOMES"
    diff <(echo "$rel_out") <(echo "$nat_out") || true
    mismatches=$((mismatches + 1))
  else
    echo "OK seed=$seed (bytes=${#rel_out})"
  fi
done

if (( mismatches > 0 )); then
  echo "FAIL: $mismatches/${#TEST_SEEDS[@]} seeds disagreed between release and native"
  echo "The native build CANNOT be deployed — its outputs would corrupt seed_cache."
  exit 1
fi

echo "PASS: all ${#TEST_SEEDS[@]} seeds agree byte-for-byte"
