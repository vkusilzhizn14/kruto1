/**
 * Spawn the C worker in `map` mode to render a top-down biome PPM
 * around spawn for a given seed, then overlay structure / biome pins
 * + a spawn star and re-encode as PNG for Telegram `sendPhoto`.
 *
 * The rendering pipeline mirrors the reference Python implementation:
 *  1. cubiomes fills a `size × size` biome grid (one C call, ms).
 *  2. cubiomes' `biomesToImage` paints biome RGB into a raw buffer.
 *  3. We overlay numbered, colour-coded pins for each structure and
 *     a star marker for spawn (drawn last so it sits on top).
 *  4. `pngjs` encodes the final RGBA buffer as PNG (~50–150 KB).
 */
import { spawn } from "node:child_process";

import { PNG } from "pngjs";

import { config } from "../config.js";
import { logger } from "../logger.js";

export interface MapPin {
  /** 1-based pin number drawn inside the disc. */
  number: number;
  /** World coordinates (blocks, origin at spawn, +x right, +z down). */
  x: number;
  z: number;
  /** Disc colour. */
  color: [number, number, number];
  /** Optional kind discriminator (used by caller only). */
  kind: "structure" | "biome";
}

interface MapOptions {
  seed: string;
  mc: string;
  largeBiomes?: boolean;
  /** Block radius from spawn the map should cover. */
  radius: number;
  /** Image side in px (default 384). */
  size?: number;
  /** Pins overlaid on the map; drawn in the order given. */
  pins: MapPin[];
}

const PIN_RADIUS = 14;

/**
 * Pick a (size, scale) combo so the rendered area is roughly 2*radius
 * blocks wide while keeping pixels at one of the cubiomes-supported
 * scales {1, 4, 16, 64, 256}. We bias toward scale=1 (voronoi, per-block
 * detail) when the user is zoomed in, because the resulting image is
 * far prettier — scale=1 is slow per-pixel but on 512x512 it's ~120ms,
 * which is fine for a one-off render. */
function pickMapDims(radius: number): { size: number; scale: number } {
  /* For close-up zooms we want each rendered pixel to map to ~1 block. */
  if (radius <= 384) {
    return { size: Math.max(256, Math.min(640, 2 * radius)), scale: 1 };
  }
  if (radius <= 1024) return { size: 384, scale: 4 };
  if (radius <= 4096) return { size: 384, scale: 16 };
  return { size: 384, scale: 64 };
}

interface RawPpm {
  width: number;
  height: number;
  rgb: Buffer;
  scale: number;
  effectiveRadius: number;
}

async function runWorkerMap(opts: MapOptions): Promise<RawPpm> {
  /* `size` from the caller overrides automatic sizing; otherwise we pick
   * a scale appropriate for the requested radius. */
  const auto = pickMapDims(opts.radius);
  const size = opts.size ?? auto.size;
  return await new Promise<RawPpm>((resolve, reject) => {
    const proc = spawn(config.workerPath, ["map"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`seed_worker map exited with code ${code ?? "?"}; stderr=${Buffer.concat(stderrChunks).toString("utf8")}`));
        return;
      }
      try {
        const blob = Buffer.concat(stdoutChunks);
        const meta = parseMeta(Buffer.concat(stderrChunks).toString("utf8"));
        resolve({ ...parsePpm(blob), scale: meta.scale, effectiveRadius: meta.effectiveRadius });
      } catch (err) {
        reject(err);
      }
    });
    proc.stdin.write(
      JSON.stringify({
        id: "map",
        mc: opts.mc,
        seed: opts.seed,
        radius: opts.radius,
        size,
        large_biomes: opts.largeBiomes ?? false,
      }) + "\n",
    );
    proc.stdin.end();
  });
}

function parseMeta(text: string): { scale: number; effectiveRadius: number } {
  /* The worker writes one JSON line to stderr after the PPM is flushed. */
  const m = text.match(/\{[^}]*\}/);
  if (!m) return { scale: 4, effectiveRadius: 0 };
  try {
    const obj = JSON.parse(m[0]) as { scale: number; effective_radius: number };
    return { scale: obj.scale, effectiveRadius: obj.effective_radius };
  } catch {
    return { scale: 4, effectiveRadius: 0 };
  }
}

function parsePpm(buf: Buffer): { width: number; height: number; rgb: Buffer } {
  /* PPM P6: magic line, "W H", "MAX", then raw RGB bytes. Comments and
   * whitespace are allowed between tokens. We're parsing our own output
   * so the format is fixed, but be defensive against extra whitespace. */
  let off = 0;
  const tokens: string[] = [];
  while (tokens.length < 4 && off < buf.length) {
    /* skip whitespace */
    while (off < buf.length && /\s/.test(String.fromCharCode(buf[off]))) off++;
    /* skip comments */
    if (buf[off] === 0x23 /* # */) {
      while (off < buf.length && buf[off] !== 0x0a) off++;
      continue;
    }
    const start = off;
    while (off < buf.length && !/\s/.test(String.fromCharCode(buf[off]))) off++;
    tokens.push(buf.slice(start, off).toString("ascii"));
  }
  if (tokens[0] !== "P6") throw new Error(`bad PPM magic: ${tokens[0]}`);
  const width = parseInt(tokens[1], 10);
  const height = parseInt(tokens[2], 10);
  const max = parseInt(tokens[3], 10);
  if (max !== 255) throw new Error(`unsupported PPM maxval ${max}`);
  /* exactly one whitespace byte after maxval, then raw bytes */
  off++;
  const rgb = buf.slice(off, off + width * height * 3);
  if (rgb.length !== width * height * 3) {
    throw new Error(`short PPM body: got ${rgb.length}, want ${width * height * 3}`);
  }
  return { width, height, rgb };
}

function worldToPx(x: number, z: number, radius: number, size: number): [number, number] {
  const px = Math.round(size / 2 + (x * size) / (2 * radius));
  const py = Math.round(size / 2 + (z * size) / (2 * radius));
  return [px, py];
}

function setPx(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function blendPx(png: PNG, x: number, y: number, r: number, g: number, b: number, alpha: number): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  const ia = 1 - alpha;
  png.data[idx] = Math.round(png.data[idx] * ia + r * alpha);
  png.data[idx + 1] = Math.round(png.data[idx + 1] * ia + g * alpha);
  png.data[idx + 2] = Math.round(png.data[idx + 2] * ia + b * alpha);
  png.data[idx + 3] = 255;
}

function fillCircle(png: PNG, cx: number, cy: number, r: number, color: [number, number, number]): void {
  const r2 = r * r;
  const r2In = (r - 1) * (r - 1);
  const r2Out = (r + 0.5) * (r + 0.5);
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2Out) continue;
      if (d2 <= r2In) {
        setPx(png, cx + dx, cy + dy, color[0], color[1], color[2]);
      } else if (d2 <= r2) {
        /* anti-aliased rim */
        const t = 1 - (Math.sqrt(d2) - (r - 1));
        blendPx(png, cx + dx, cy + dy, color[0], color[1], color[2], Math.max(0, Math.min(1, t)));
      }
    }
  }
}

function strokeCircle(png: PNG, cx: number, cy: number, r: number, color: [number, number, number], width: number): void {
  /* simple two-radius fill diff for a thick outline */
  const inner = Math.max(0, r - width);
  const r2Outer = r * r;
  const r2Inner = inner * inner;
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2Outer && d2 >= r2Inner) {
        setPx(png, cx + dx, cy + dy, color[0], color[1], color[2]);
      }
    }
  }
}

/* ---------- digit bitmap font (5×7 per digit, 1bit) ---------- */

const DIGIT_GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

function drawDigit(png: PNG, ch: string, cx: number, cy: number, color: [number, number, number], scale = 2): void {
  const g = DIGIT_GLYPHS[ch];
  if (!g) return;
  const w = 5 * scale;
  const h = 7 * scale;
  const x0 = cx - Math.floor(w / 2);
  const y0 = cy - Math.floor(h / 2);
  for (let yy = 0; yy < 7; yy++) {
    for (let xx = 0; xx < 5; xx++) {
      if (g[yy][xx] === "1") {
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++)
            setPx(png, x0 + xx * scale + sx, y0 + yy * scale + sy,
              color[0], color[1], color[2]);
      }
    }
  }
}

function drawNumber(png: PNG, n: number, cx: number, cy: number, color: [number, number, number]): void {
  const s = String(n);
  const charW = 5 * 2;
  const totalW = s.length * charW + (s.length - 1) * 1;
  let x = cx - Math.floor(totalW / 2) + Math.floor(charW / 2);
  for (const ch of s) {
    drawDigit(png, ch, x, cy, color);
    x += charW + 1;
  }
}

/* ---------- public API ---------- */

export async function renderMapPng(opts: MapOptions): Promise<Buffer> {
  const t0 = Date.now();
  const raw = await runWorkerMap(opts);
  const { width, height, rgb, effectiveRadius } = raw;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4 + 0] = rgb[i * 3 + 0];
    png.data[i * 4 + 1] = rgb[i * 3 + 1];
    png.data[i * 4 + 2] = rgb[i * 3 + 2];
    png.data[i * 4 + 3] = 255;
  }

  /* Pins: drop-shadow, filled disc, black outline, white number. */
  const projRadius = effectiveRadius > 0 ? effectiveRadius : opts.radius;
  for (const pin of opts.pins) {
    if (Math.max(Math.abs(pin.x), Math.abs(pin.z)) > projRadius) continue;
    const [cx, cy] = worldToPx(pin.x, pin.z, projRadius, width);
    /* shadow */
    fillCircle(png, cx + 1, cy + 2, PIN_RADIUS + 1, [0, 0, 0]);
    /* coloured disc */
    fillCircle(png, cx, cy, PIN_RADIUS, pin.color);
    /* outline */
    strokeCircle(png, cx, cy, PIN_RADIUS, [0, 0, 0], 2);
    /* number — pick white or black based on background luminance */
    const lum = 0.299 * pin.color[0] + 0.587 * pin.color[1] + 0.114 * pin.color[2];
    const txt: [number, number, number] = lum > 160 ? [0, 0, 0] : [255, 255, 255];
    drawNumber(png, pin.number, cx, cy, txt);
  }

  /* Spawn marker: filled black disc + white inner ring; sits on top. */
  const sx = Math.floor(width / 2);
  const sy = Math.floor(height / 2);
  fillCircle(png, sx, sy, 11, [0, 0, 0]);
  fillCircle(png, sx, sy, 8, [255, 255, 255]);
  fillCircle(png, sx, sy, 4, [0, 0, 0]);

  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    png
      .pack()
      .on("data", (b: Buffer) => out.push(b))
      .on("end", () => resolve())
      .on("error", reject);
  });
  const png_bytes = Buffer.concat(out);
  logger.debug({ ms: Date.now() - t0, size: png_bytes.length }, "rendered map");
  return png_bytes;
}
