#include "json.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *skip_ws(const char *s) {
    while (*s && isspace((unsigned char)*s)) s++;
    return s;
}

const char *json_find_key(const char *s, const char *key) {
    size_t klen = strlen(key);
    const char *p = s;
    while ((p = strchr(p, '"')) != NULL) {
        if (strncmp(p + 1, key, klen) == 0 && p[1 + klen] == '"') {
            const char *q = p + 1 + klen + 1; /* past closing quote */
            q = skip_ws(q);
            if (*q == ':') {
                q++;
                return skip_ws(q);
            }
        }
        p++;
    }
    return NULL;
}

const char *json_parse_string(const char *s, char *dst, size_t dst_len) {
    if (*s != '"') return NULL;
    s++;
    size_t i = 0;
    while (*s && *s != '"') {
        if (*s == '\\' && s[1]) {
            char esc = s[1];
            char out;
            switch (esc) {
                case '"': out = '"'; break;
                case '\\': out = '\\'; break;
                case '/': out = '/'; break;
                case 'n': out = '\n'; break;
                case 't': out = '\t'; break;
                case 'r': out = '\r'; break;
                default: out = esc; break;
            }
            if (i + 1 < dst_len) dst[i++] = out;
            s += 2;
        } else {
            if (i + 1 < dst_len) dst[i++] = *s;
            s++;
        }
    }
    if (*s != '"') return NULL;
    dst[i] = '\0';
    return s + 1;
}

int json_parse_int64(const char *s, int64_t *out, const char **end) {
    char *e = NULL;
    errno = 0;
    long long v = strtoll(s, &e, 10);
    if (e == s || errno != 0) return 0;
    *out = (int64_t)v;
    if (end) *end = e;
    return 1;
}

int json_parse_uint64(const char *s, uint64_t *out, const char **end) {
    /* Accept either a JSON number or a string-wrapped uint64 (for IDs > 2^53). */
    if (*s == '"') {
        char buf[32];
        const char *q = json_parse_string(s, buf, sizeof(buf));
        if (!q) return 0;
        char *e = NULL;
        errno = 0;
        unsigned long long v = strtoull(buf, &e, 10);
        if (e == buf || errno != 0) return 0;
        *out = (uint64_t)v;
        if (end) *end = q;
        return 1;
    }
    char *e = NULL;
    errno = 0;
    /* Use strtoll then cast; allows negative seed inputs. */
    long long v = strtoll(s, &e, 10);
    if (e == s || errno != 0) return 0;
    *out = (uint64_t)v;
    if (end) *end = e;
    return 1;
}

int json_parse_bool(const char *s, bool *out, const char **end) {
    if (strncmp(s, "true", 4) == 0) {
        *out = true;
        if (end) *end = s + 4;
        return 1;
    }
    if (strncmp(s, "false", 5) == 0) {
        *out = false;
        if (end) *end = s + 5;
        return 1;
    }
    return 0;
}

int json_iter_string_array(const char *arr, json_string_array_cb cb, void *ctx) {
    arr = skip_ws(arr);
    if (*arr != '[') return -1;
    arr++;
    arr = skip_ws(arr);
    if (*arr == ']') return 0;
    while (*arr) {
        arr = skip_ws(arr);
        char item[64];
        const char *next = json_parse_string(arr, item, sizeof(item));
        if (!next) return -1;
        int rc = cb(item, ctx);
        if (rc != 0) return rc;
        arr = skip_ws(next);
        if (*arr == ',') { arr++; continue; }
        if (*arr == ']') return 0;
        return -1;
    }
    return -1;
}

void json_emit_string(const char *key, const char *value) {
    printf("\"%s\":\"", key);
    for (const char *p = value; *p; p++) {
        switch (*p) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if ((unsigned char)*p < 0x20) {
                    printf("\\u%04x", (unsigned char)*p);
                } else {
                    fputc(*p, stdout);
                }
        }
    }
    fputc('"', stdout);
}
