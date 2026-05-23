/*
 * Minimal JSON helpers for the worker.
 *
 * The worker only ever parses requests we generate ourselves and emits
 * responses on a single line of stdout. We therefore avoid pulling in a
 * full JSON library and instead expose a small set of typed accessors that
 * understand exactly the shape we use.
 *
 * The parser is non-strict and assumes well-formed input from the bot. It is
 * not intended for arbitrary user data.
 */

#ifndef KR_JSON_H
#define KR_JSON_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Find the first occurrence of `"<key>":` in `s` and return a pointer past
 * the colon (and any whitespace). Returns NULL if not found. */
const char *json_find_key(const char *s, const char *key);

/* Parse a JSON string literal starting at `s` (must point at the opening
 * `"`). Writes up to `dst_len-1` bytes plus NUL into `dst`. Returns a pointer
 * just after the closing quote, or NULL on error. */
const char *json_parse_string(const char *s, char *dst, size_t dst_len);

/* Parse a JSON integer at `s`. Returns 0/1 on success and stores the value.
 * On success, `*end` is set to the first character past the number. */
int json_parse_int64(const char *s, int64_t *out, const char **end);
int json_parse_uint64(const char *s, uint64_t *out, const char **end);

/* Parse a JSON boolean (true/false). Returns 0/1 on success. */
int json_parse_bool(const char *s, bool *out, const char **end);

/* Iterate over a JSON array of strings at `arr` (must point at `[`). For
 * each element, invoke `cb(item, ctx)`. Stops when cb returns non-zero or
 * the array is exhausted. */
typedef int (*json_string_array_cb)(const char *item, void *ctx);
int json_iter_string_array(const char *arr, json_string_array_cb cb, void *ctx);

/* Emit `"key":"value"` with backslash-escaped value to stdout. */
void json_emit_string(const char *key, const char *value);

#endif /* KR_JSON_H */
