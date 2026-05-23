/**
 * Inline-keyboard builders for the biome/structure picker UI.
 *
 * Layout:
 *   [biome 1] [biome 2]
 *   [biome 3] [biome 4]
 *   ...
 *   [‹ prev]  [next ›]
 *   [Clear selection]
 *   [⬅ Back]  [▶ Continue]
 *
 * Buttons are rendered with a leading ✅ when the item is currently selected.
 * Callback data is encoded as `pick:<kind>:<id>` / `pick:nav:<kind>:<page>`
 * etc.; payloads are kept short to stay within Telegram's 64-byte limit.
 */

import {
  type BiomeInfo,
  type McVersion,
  type StructureInfo,
  biomesForVersion,
  structuresForVersion,
} from "@kruto52/shared";
import { InlineKeyboard } from "grammy";

import { config } from "../config.js";

const PER_ROW = Math.max(1, Math.min(4, config.picksPerRow));
const PER_PAGE = Math.max(4, Math.min(20, config.itemsPerPage));

export function biomePickerKeyboard(opts: {
  version: McVersion;
  selected: ReadonlySet<string>;
  page: number;
}): InlineKeyboard {
  const items = biomesForVersion(opts.version);
  return makePickerKeyboard({
    items: items.map((b) => ({ id: b.id, label: `${b.emoji} ${b.nameRu}` })),
    kind: "biomes",
    selected: opts.selected,
    page: opts.page,
  });
}

export function structurePickerKeyboard(opts: {
  version: McVersion;
  selected: ReadonlySet<string>;
  page: number;
}): InlineKeyboard {
  const items = structuresForVersion(opts.version);
  return makePickerKeyboard({
    items: items.map((s) => ({ id: s.id, label: `${s.emoji} ${s.nameRu}` })),
    kind: "structures",
    selected: opts.selected,
    page: opts.page,
  });
}

interface PickItem {
  id: string;
  label: string;
}

function makePickerKeyboard(opts: {
  items: PickItem[];
  kind: "biomes" | "structures";
  selected: ReadonlySet<string>;
  page: number;
}): InlineKeyboard {
  const pageCount = Math.max(1, Math.ceil(opts.items.length / PER_PAGE));
  const page = Math.max(0, Math.min(pageCount - 1, opts.page));
  const start = page * PER_PAGE;
  const slice = opts.items.slice(start, start + PER_PAGE);
  const kb = new InlineKeyboard();
  let placed = 0;
  for (const item of slice) {
    const prefix = opts.selected.has(item.id) ? "✅ " : "▫️ ";
    kb.text(`${prefix}${item.label}`, `pick:${opts.kind}:${item.id}`);
    placed++;
    if (placed % PER_ROW === 0) kb.row();
  }
  if (placed % PER_ROW !== 0) kb.row();

  if (pageCount > 1) {
    if (page > 0) kb.text("‹ Назад", `pick:nav:${opts.kind}:${page - 1}`);
    kb.text(`Стр. ${page + 1}/${pageCount}`, "noop");
    if (page < pageCount - 1) kb.text("Далее ›", `pick:nav:${opts.kind}:${page + 1}`);
    kb.row();
  }

  if (opts.selected.size > 0) {
    kb.text("Очистить выбор", `pick:clear:${opts.kind}`).row();
  }

  if (opts.kind === "biomes") {
    kb.text("⬅ Версия", "search:back:version").text("Дальше: структуры ▶", "search:to:structures");
  } else {
    kb.text("⬅ Биомы", "search:back:biomes").text("📏 Дальше: радиус ▶", "search:to:radius");
  }
  return kb;
}

export function versionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Minecraft 1.21", "search:version:1.21")
    .row()
    .text("Minecraft 1.20", "search:version:1.20");
}

export function radiusKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of [
    { id: "100", label: "🎯 На спавне (100 блоков)" },
    { id: "200", label: "🎯 Совсем рядом (200 блоков)" },
    { id: "500", label: "📍 Близко (500 блоков)" },
    { id: "1000", label: "🗺 Чуть дальше (1000 блоков)" },
  ]) {
    kb.text(r.label, `search:radius:${r.id}`).row();
  }
  return kb;
}

export function summaryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔍 Запустить", "search:run")
    .row()
    .text("✏️ Изменить биомы", "search:to:biomes")
    .text("✏️ Изменить структуры", "search:to:structures")
    .row()
    .text("✏️ Радиус", "search:back:radius")
    .text("✏️ Версия", "search:back:version");
}

export function resultKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Найти другой", "search:next")
    .row()
    .text("🆕 Новый поиск", "search:restart")
    .text("💎 Купить кредиты", "buy:open");
}

/** Used to render a list of currently selected items for the summary. */
export function listSelected(
  source: ReadonlyArray<BiomeInfo | StructureInfo>,
  selected: ReadonlySet<string>,
): string {
  const names = source.filter((x) => selected.has(x.id)).map((x) => `${x.emoji} ${x.nameRu}`);
  if (names.length === 0) return "—";
  return names.join(", ");
}
