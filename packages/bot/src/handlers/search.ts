/**
 * /search wizard + result delivery.
 *
 * Conversation flow (single message, edited in place):
 *
 *   1. Choose Minecraft version
 *   2. Pick biomes (paginated)
 *   3. Pick structures (paginated)
 *   4. Choose radius
 *   5. Confirm summary and run
 *   6. Show result with "Find another" / "New search" / "Buy" buttons
 *
 * All transitions edit the original message and never spam new ones,
 * which keeps history clean and stays under Telegram rate limits.
 */

import {
  BIOMES,
  STRUCTURES,
  type McVersion,
  biomesForVersion,
  getPreset,
  getRadius,
  structuresForVersion,
} from "@kruto52/shared";
import type { CallbackQueryContext, CommandContext, Context, HearsContext } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";

import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  biomePickerKeyboard,
  liveSearchInProgressKeyboard,
  listSelected,
  radiusKeyboard,
  resultKeyboard,
  structurePickerKeyboard,
  summaryKeyboard,
  versionKeyboard,
} from "../keyboards/picker.js";
import { presetsKeyboard } from "../keyboards/main.js";
import { renderMapPng, type MapPin } from "../services/map.js";
import { releaseLive, tryAcquireLive } from "../middleware/rate_limit.js";
import { findSeed, recordSearchHistory, type SearchOutcome } from "../services/search.js";
import {
  bumpFreeUsage,
  changeCredits,
  freeHitsRemainingForUser,
  hasActivePro,
  upsertUser,
  type UserRow,
} from "../services/users.js";
import { PRO_TRIAL_CALLBACK } from "./trial.js";
import { clearState, getState, setState, type PickerState } from "../state.js";

function newState(version: McVersion): PickerState {
  return {
    version,
    radius: getRadius("500"),
    biomes: new Set(),
    structures: new Set(),
    page: { biomes: 0, structures: 0 },
    excludeSeeds: new Set(),
  };
}

/**
 * Per-user controller for the currently-running live search. Filled when
 * a user enters the live search path (queue or worker) and cleared on
 * any outcome. The "Cancel" button callback aborts via this controller
 * which dequeues a still-queued waiter or SIGTERMs the running worker.
 */
const activeLiveSearches = new Map<number, AbortController>();

function summaryText(state: PickerState): string {
  return [
    "🧩 Твои критерии:",
    `Версия: <b>Minecraft ${state.version}</b>`,
    `Радиус: <b>${state.radius.nameRu}</b>`,
    `Биомы: ${listSelected(BIOMES, state.biomes)}`,
    `Структуры: ${listSelected(STRUCTURES, state.structures)}`,
    "",
    "Если всё ок — жми «🔍 Запустить».",
  ].join("\n");
}

/* ---------- entry points ---------- */

export async function handleSearchCommand(
  ctx: CommandContext<Context> | HearsContext<Context>,
): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  clearState(ctx.chat.id);
  await ctx.reply("Выбери версию Minecraft:", { reply_markup: versionKeyboard() });
}

export async function handlePresetsMenu(
  ctx: CommandContext<Context> | HearsContext<Context>,
): Promise<void> {
  await ctx.reply("Готовые пресеты для самого красивого спавна:", {
    reply_markup: presetsKeyboard(),
  });
}

export async function handlePreset(ctx: CallbackQueryContext<Context>): Promise<void> {
  const m = /^preset:(\w+)$/.exec(ctx.callbackQuery.data ?? "");
  if (!m || !ctx.chat || !ctx.from) return;
  const preset = getPreset(m[1]!);
  if (!preset) {
    await ctx.answerCallbackQuery({ text: "Пресет не найден", show_alert: true });
    return;
  }
  await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  const state = newState(preset.version);
  state.radius = getRadius(preset.radius);
  state.biomes = new Set(preset.biomes);
  state.structures = new Set(preset.structures);
  setState(ctx.chat.id, state);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(summaryText(state), {
    parse_mode: "HTML",
    reply_markup: summaryKeyboard(),
  });
}

/* ---------- callback router ---------- */

export async function handleSearchCallback(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  const data = ctx.callbackQuery.data ?? "";
  if (!ctx.chat || !ctx.from) return;
  const chatId = ctx.chat.id;

  if (data === "noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith("search:version:")) {
    const v = data.slice("search:version:".length) as McVersion;
    const state = newState(v);
    setState(chatId, state);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🌳 Выбери нужные биомы (можно несколько):", {
      reply_markup: biomePickerKeyboard({ version: v, selected: state.biomes, page: 0 }),
    });
    return;
  }

  if (data === "search:back:version") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Выбери версию Minecraft:", {
      reply_markup: versionKeyboard(),
    });
    return;
  }

  const state = getState(chatId, () => newState("1.21"));

  if (data.startsWith("pick:biomes:") || data.startsWith("pick:structures:")) {
    const [, kind, id] = data.split(":");
    const set = kind === "biomes" ? state.biomes : state.structures;
    if (set.has(id!)) set.delete(id!);
    else set.add(id!);
    setState(chatId, state);
    await ctx.answerCallbackQuery();
    await renderPicker(ctx, state, kind as "biomes" | "structures");
    return;
  }

  if (data.startsWith("pick:nav:")) {
    const [, , kind, page] = data.split(":");
    const k = kind as "biomes" | "structures";
    state.page[k] = Number(page);
    setState(chatId, state);
    await ctx.answerCallbackQuery();
    await renderPicker(ctx, state, k);
    return;
  }

  if (data.startsWith("pick:clear:")) {
    const kind = data.slice("pick:clear:".length) as "biomes" | "structures";
    if (kind === "biomes") state.biomes.clear();
    else state.structures.clear();
    setState(chatId, state);
    await ctx.answerCallbackQuery({ text: "Очищено" });
    await renderPicker(ctx, state, kind);
    return;
  }

  if (data === "search:to:biomes") {
    await ctx.answerCallbackQuery();
    await renderPicker(ctx, state, "biomes");
    return;
  }
  if (data === "search:to:structures") {
    await ctx.answerCallbackQuery();
    await renderPicker(ctx, state, "structures");
    return;
  }
  if (data === "search:back:biomes") {
    await ctx.answerCallbackQuery();
    await renderPicker(ctx, state, "biomes");
    return;
  }
  if (data === "search:back:radius" || data === "search:to:radius") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("📏 Выбери радиус от спавна:", {
      reply_markup: radiusKeyboard(),
    });
    return;
  }

  if (data.startsWith("search:radius:")) {
    const id = data.slice("search:radius:".length);
    state.radius = getRadius(id);
    setState(chatId, state);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(summaryText(state), {
      parse_mode: "HTML",
      reply_markup: summaryKeyboard(),
    });
    return;
  }

  // After structures picker → go to radius
  if (data === "search:run" && state.radius === undefined) {
    // not used; radius is always set
  }

  if (data === "search:run") {
    if (state.biomes.size === 0 && state.structures.size === 0) {
      await ctx.answerCallbackQuery({
        text: "Выбери хотя бы один биом или структуру",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Ищу сид…" });
    await runSearch(ctx, state, false);
    return;
  }

  if (data === "search:next") {
    await ctx.answerCallbackQuery({ text: "Ищу другой сид…" });
    await runSearch(ctx, state, true);
    return;
  }

  if (data === "search:cancel") {
    /* Cancel triggers the AbortController associated with the user. The
     * actual UI update (text + reply markup) is handled inside runSearch
     * once the cancelled outcome propagates back; we just ack here. */
    const ac = activeLiveSearches.get(ctx.from.id);
    if (!ac) {
      await ctx.answerCallbackQuery({ text: "Поиск уже завершён" });
      return;
    }
    ac.abort();
    await ctx.answerCallbackQuery({ text: "Останавливаю…" });
    return;
  }

  if (data === "search:restart") {
    clearState(chatId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Выбери версию Minecraft:", {
      reply_markup: versionKeyboard(),
    });
    return;
  }

  if (data === "search:radius_step") {
    // structures→radius transition fires this; we re-show radius keyboard
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("📏 Выбери радиус от спавна:", {
      reply_markup: radiusKeyboard(),
    });
    return;
  }
}

async function renderPicker(
  ctx: CallbackQueryContext<Context>,
  state: PickerState,
  kind: "biomes" | "structures",
): Promise<void> {
  if (kind === "biomes") {
    const items = biomesForVersion(state.version);
    await ctx.editMessageText(
      `🌳 Биомы (выбрано ${state.biomes.size}). Это лесные, океанские, горные и редкие биомы — отметь, что должно быть рядом со спавном.`,
      {
        reply_markup: biomePickerKeyboard({
          version: state.version,
          selected: state.biomes,
          page: state.page.biomes,
        }),
      },
    );
    void items;
  } else {
    const items = structuresForVersion(state.version);
    await ctx.editMessageText(
      `🏛️ Структуры (выбрано ${state.structures.size}). Деревни, особняки, древние города и т.д.`,
      {
        reply_markup: structurePickerKeyboard({
          version: state.version,
          selected: state.structures,
          page: state.page.structures,
        }),
      },
    );
    void items;
  }
}

/**
 * Build the inline keyboard shown when the daily free quota is empty.
 * Surfaces the one-shot Pro trial button only if the user hasn't used
 * it yet. Otherwise we go straight to the buy / pro purchase options.
 */
function outOfQuotaKeyboard(user: UserRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (user.pro_trial_used_at === null) {
    kb.text("🎁 Активировать Pro на 24ч бесплатно", PRO_TRIAL_CALLBACK).row();
  }
  kb.text("💎 Купить кредиты / Pro", "buy:open").row();
  kb.text("⭐️ К пресетам", "preset:menu");
  return kb;
}

type StatusSetter = (text: string, extra?: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard }) => Promise<void>;

/**
 * Renders the "out of quota" message offering the one-shot Pro trial
 * (when available) and purchase options. Called from both cache-hit and
 * live-search branches once free quota and balance are both exhausted.
 */
async function offerOutOfQuota(
  _ctx: CallbackQueryContext<Context>,
  user: UserRow,
  setStatus: StatusSetter,
): Promise<void> {
  const lines: string[] = [
    "😔 Дневные бесплатные поиски исчерпаны и кредиты закончились.",
    "",
  ];
  if (user.pro_trial_used_at === null) {
    lines.push(
      "🎁 Для тебя доступен <b>бесплатный Pro-триал на 24 часа</b> — безлимитный поиск, один раз на аккаунт.",
      "",
      "После триала — пакеты кредитов или Pro подписка.",
    );
  } else {
    lines.push(
      "Бесплатный Pro-триал уже был использован. Купи пакет кредитов или Pro подписку, чтобы продолжить.",
    );
  }
  await setStatus(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: outOfQuotaKeyboard(user),
  });
}

async function runSearch(
  ctx: CallbackQueryContext<Context>,
  state: PickerState,
  another: boolean,
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const user = await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  const isPro = hasActivePro(user);
  /* Free hits apply only to non-Pro users — Pro is unlimited. */
  const freeRemaining = isPro
    ? Number.POSITIVE_INFINITY
    : await freeHitsRemainingForUser(user.id, config.freeDailyHits);
  const exclude = another ? Array.from(state.excludeSeeds, BigInt) : [];

  /* The previous result might have been a photo (rendered map). Telegram
   * doesn't allow editMessageText on a photo message, so for "find another"
   * we first delete the photo and replace it with a fresh text status
   * message we control end-to-end. */
  const chatId = ctx.chat.id;
  let statusMsgId: number;
  try {
    await ctx.editMessageText("⚡ Проверяю кеш…", { reply_markup: undefined });
    statusMsgId = ctx.callbackQuery.message!.message_id;
  } catch {
    try { await ctx.deleteMessage(); } catch { /* not deletable, ignore */ }
    const m = await ctx.api.sendMessage(chatId, "⚡ Проверяю кеш…");
    statusMsgId = m.message_id;
  }

  /* Helper: replace the status message text/markup, falling back to a new
   * message if the existing one can't be edited (e.g. became a photo
   * since we last tracked it). We accept the loosest of the two API
   * `other` shapes so callers can pass parse_mode/reply_markup freely. */
  type StatusExtra = { parse_mode?: "HTML"; reply_markup?: InlineKeyboard };
  const setStatus = async (text: string, extra?: StatusExtra): Promise<void> => {
    try {
      await ctx.api.editMessageText(chatId, statusMsgId, text, extra);
    } catch (err) {
      logger.debug({ err }, "status edit failed; sending fresh");
      const m = await ctx.api.sendMessage(chatId, text, extra);
      statusMsgId = m.message_id;
    }
  };

  // Step 1: try cache only
  const cacheResult = await findSeed({
    userId: user.id,
    mc: state.version,
    largeBiomes: false,
    radius: state.radius,
    biomeIds: Array.from(state.biomes),
    structureIds: Array.from(state.structures),
    excludeSeeds: exclude,
    allowLiveSearch: false,
  });

  if (cacheResult.ok) {
    /* Cache hit. Decide payment: Pro → free; else if free hits remain →
     * consume one free hit; else if balance available → debit a credit;
     * else fall through to the "out of quota" branch below. */
    let debited = 0;
    let usedFree = false;
    if (isPro) {
      // free for Pro
    } else if (freeRemaining > 0) {
      await bumpFreeUsage(user.id);
      usedFree = true;
    } else if (user.balance_credits > 0) {
      await changeCredits({
        userId: user.id,
        delta: -1,
        reason: "search:cache",
        metadata: { seed: cacheResult.outcome.seed.toString() },
      });
      debited = 1;
    } else {
      await offerOutOfQuota(ctx, user, setStatus);
      await recordSearchHistory({
        userId: user.id,
        mc: state.version,
        largeBiomes: false,
        radius: state.radius,
        biomeIds: Array.from(state.biomes),
        structureIds: Array.from(state.structures),
        result: { ok: false, reason: "no_credits" },
        debited: 0,
      });
      return;
    }
    state.excludeSeeds.add(cacheResult.outcome.seed.toString());
    setState(ctx.chat.id, state);
    await recordSearchHistory({
      userId: user.id,
      mc: state.version,
      largeBiomes: false,
      radius: state.radius,
      biomeIds: Array.from(state.biomes),
      structureIds: Array.from(state.structures),
      result: cacheResult,
      debited,
    });
    const refreshed = await upsertUser({
      tgId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      language: ctx.from.language_code,
    });
    await renderResult(ctx, cacheResult.outcome, refreshed, state.radius.blocks, debited > 0, state.version, statusMsgId, usedFree);
    return;
  }

  // Step 2: cache miss → pick payment source for the live search
  let livePayment: "pro" | "free" | "credit";
  if (isPro) {
    livePayment = "pro";
  } else if (freeRemaining > 0) {
    livePayment = "free";
  } else if (user.balance_credits > 0) {
    livePayment = "credit";
  } else {
    await offerOutOfQuota(ctx, user, setStatus);
    await recordSearchHistory({
      userId: user.id,
      mc: state.version,
      largeBiomes: false,
      radius: state.radius,
      biomeIds: Array.from(state.biomes),
      structureIds: Array.from(state.structures),
      result: { ok: false, reason: "no_credits" },
      debited: 0,
    });
    return;
  }

  // Step 3: run live search with progress.
  // Single-flight per user: refuse if a previous live search is still in
  // flight (worker process still running). Prevents fork-bomb spam.
  if (!tryAcquireLive(user.tg_id)) {
    await setStatus(
      "⏳ Предыдущий поиск ещё работает. Дождись результата или нажми «Отменить поиск».",
      { reply_markup: liveSearchInProgressKeyboard() },
    );
    return;
  }
  /* Start optimistic: assume slot will be free, immediate engine launch.
   * If onQueued fires, we flip to the queued UI. The cancel button is
   * present from the start so the user can bail out at any point. */
  await setStatus("🔥 Запускаю движок на cubiomes…\n0 сидов проверено", {
    reply_markup: liveSearchInProgressKeyboard(),
  });

  /* AbortController binds the "Cancel" button to the in-flight search.
   * Aborting before the slot is granted dequeues the waiter; after the
   * slot is granted, the same controller is used to SIGTERM the worker
   * inside services/search.ts. */
  const ac = new AbortController();
  activeLiveSearches.set(user.tg_id, ac);

  /* Progress / position updates are coalesced to at most one Telegram
   * edit per second per user to stay well within rate limits. */
  let lastUpdate = 0;
  const rateLimitedEdit = (text: string): void => {
    const now = Date.now();
    if (now - lastUpdate < 1000) return;
    lastUpdate = now;
    ctx.api
      .editMessageText(chatId, statusMsgId, text, {
        parse_mode: "HTML",
        reply_markup: liveSearchInProgressKeyboard(),
      })
      .catch((err) => logger.debug({ err }, "live status edit failed"));
  };

  let liveResult;
  try {
    liveResult = await findSeed({
      userId: user.id,
      mc: state.version,
      largeBiomes: false,
      radius: state.radius,
      biomeIds: Array.from(state.biomes),
      structureIds: Array.from(state.structures),
      excludeSeeds: exclude,
      cancelSignal: ac.signal,
      liveCallbacks: {
        onQueued: (pos) => {
          /* First time the user lands in the queue. The `setStatus`
           * call above happened before findSeed; this overrides it
           * with the queued message. Bypasses the 1s rate-limit so
           * the user immediately sees they're queued. */
          ctx.api
            .editMessageText(
              chatId,
              statusMsgId,
              `⏳ Свободных потоков нет, поиск встал в очередь.\nТвоя позиция: <b>${pos}</b>. Жду когда освободится…`,
              {
                parse_mode: "HTML",
                reply_markup: liveSearchInProgressKeyboard(),
              },
            )
            .catch((err) => logger.debug({ err }, "queued status edit failed"));
        },
        onPositionChanged: (pos) => {
          if (pos === 0) {
            /* Slot will be granted in a moment; switch to "starting". */
            rateLimitedEdit("🔥 Запускаю движок на cubiomes…\n0 сидов проверено");
          } else {
            rateLimitedEdit(
              `⏳ Поиск в очереди. Твоя позиция: <b>${pos}</b>.\nЖду когда освободится…`,
            );
          }
        },
        onSearchStarted: () => {
          /* Bypass rate limit: this is a state transition, not noisy
           * progress. Tells the user the engine actually started. */
          lastUpdate = Date.now();
          ctx.api
            .editMessageText(
              chatId,
              statusMsgId,
              "🔥 Запускаю движок на cubiomes…\n0 сидов проверено",
              {
                parse_mode: "HTML",
                reply_markup: liveSearchInProgressKeyboard(),
              },
            )
            .catch((err) => logger.debug({ err }, "start status edit failed"));
        },
      },
      callbacks: {
        onProgress: (p) => {
          rateLimitedEdit(
            `🔥 Ищу сид (${Math.round(p.elapsed_ms / 1000)}c)…\nПроверено ${p.seeds_tested.toLocaleString("ru-RU")} сидов · ${p.seeds_per_sec.toLocaleString("ru-RU")} сид/с`,
          );
        },
      },
    });
  } finally {
    releaseLive(user.tg_id);
    activeLiveSearches.delete(user.tg_id);
  }

  let debited = 0;
  let usedFree = false;
  if (liveResult.ok) {
    state.excludeSeeds.add(liveResult.outcome.seed.toString());
    setState(ctx.chat.id, state);
    if (livePayment === "free") {
      await bumpFreeUsage(user.id);
      usedFree = true;
    } else if (livePayment === "credit") {
      await changeCredits({
        userId: user.id,
        delta: -1,
        reason: "search:live",
        metadata: { seed: liveResult.outcome.seed.toString() },
      });
      debited = 1;
    }
    const refreshed = await upsertUser({
      tgId: ctx.from!.id,
      username: ctx.from!.username,
      firstName: ctx.from!.first_name,
      language: ctx.from!.language_code,
    });
    await renderResult(ctx, liveResult.outcome, refreshed, state.radius.blocks, debited > 0, state.version, statusMsgId, usedFree);
  } else if (liveResult.reason === "not_found") {
    const tested = liveResult.seedsTested ?? 0;
    const elapsedSec = (liveResult.elapsedMs ?? 0) / 1000;
    const rate = elapsedSec > 0 ? Math.round(tested / elapsedSec) : 0;
    const lines = [
      "❌ Сид с такой комбинацией не найден.",
      "",
      `Проверено: <b>${tested.toLocaleString("ru-RU")}</b> сидов за <b>${elapsedSec.toFixed(1)} с</b> (~${rate.toLocaleString("ru-RU")} сид/с).`,
      "",
      "Эта связка фильтров либо слишком редкая для такого радиуса, либо вовсе невозможна (например деревня и аванпост рядом — они избегают друг друга).",
      "",
      "Попробуй увеличить радиус, убрать один-два критерия или взять другой пресет. <b>Кредит не списан</b>.",
    ];
    await setStatus(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: resultKeyboard(),
    });
  } else if (liveResult.reason === "cancelled") {
    /* No credit was debited (we only debit on `ok`) so the user pays
     * nothing for a cancelled search. Drop the cancel button — the
     * search is no longer in flight. */
    await setStatus("⏹ Поиск остановлен. Кредит не списан.", {
      reply_markup: resultKeyboard(),
    });
  } else {
    await setStatus(`⚠️ Ошибка поиска: ${liveResult.detail ?? liveResult.reason}`, {
      reply_markup: resultKeyboard(),
    });
  }

  await recordSearchHistory({
    userId: user.id,
    mc: state.version,
    largeBiomes: false,
    radius: state.radius,
    biomeIds: Array.from(state.biomes),
    structureIds: Array.from(state.structures),
    result: liveResult,
    debited,
  });
}

/**
 * Pick a distinguishable disc colour per pin. We use one palette for
 * structures and a similar-but-cooler one for biomes so the user can
 * tell categories apart at a glance.
 */
const STRUCT_COLORS: ReadonlyArray<[number, number, number]> = [
  [240, 196, 25],   // gold
  [138, 30, 30],    // crimson
  [60, 0, 90],      // deep purple
  [30, 120, 200],   // ocean blue
  [180, 60, 180],   // magenta
  [255, 215, 0],    // bright gold
  [100, 70, 50],    // brown
  [180, 80, 200],   // trial purple
];

const BIOME_COLORS: ReadonlyArray<[number, number, number]> = [
  [200, 230, 255],  // pale blue
  [255, 200, 220],  // pink
  [220, 255, 200],  // mint
  [255, 230, 170],  // peach
  [220, 220, 255],  // lilac
  [255, 240, 200],  // cream
];

function buildPins(outcome: SearchOutcome): { pins: MapPin[]; legend: string[] } {
  /* Sort each list by distance from spawn so pin 1 is the closest. */
  const sortByDist = <T extends { x: number; z: number }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));
  const structs = sortByDist(outcome.structures);
  const biomes = sortByDist(outcome.biomes);

  const pins: MapPin[] = [];
  const legend: string[] = [];
  let n = 1;
  for (const s of structs) {
    const color = STRUCT_COLORS[(n - 1) % STRUCT_COLORS.length]!;
    pins.push({ number: n, x: s.x, z: s.z, color, kind: "structure" });
    legend.push(`${n} — 🏛 ${s.nameRu} (${s.x}, ${s.z})`);
    n++;
  }
  for (const b of biomes) {
    const color = BIOME_COLORS[(n - 1) % BIOME_COLORS.length]!;
    pins.push({ number: n, x: b.x, z: b.z, color, kind: "biome" });
    legend.push(`${n} — 🌳 ${b.nameRu} (${b.x}, ${b.z})`);
    n++;
  }
  return { pins, legend };
}

function balanceFooter(user: UserRow, debited: boolean, usedFree: boolean): string {
  if (hasActivePro(user)) return "💠 У тебя активна Pro подписка — поиск без лимита.";
  if (debited) {
    return `💎 Списан 1 кредит. Осталось: <b>${Math.max(0, user.balance_credits)}</b>.`;
  }
  if (usedFree) {
    /* `user` is refetched after bumping; freeHitsRemaining uses current
     * counter values. We display the remaining count for transparency. */
    const remaining = Math.max(0, config.freeDailyHits - user.free_used_today);
    return `🎁 Бесплатный поиск (${remaining} из ${config.freeDailyHits} осталось сегодня). Баланс: <b>${user.balance_credits}</b> кредитов.`;
  }
  return `🎁 Бесплатно. Баланс: <b>${user.balance_credits}</b> кредитов.`;
}

async function renderResult(
  ctx: CallbackQueryContext<Context>,
  outcome: SearchOutcome,
  user: UserRow,
  radius: number,
  charged: boolean,
  mc: McVersion,
  /** Status message we created in runSearch — gets deleted before
   * the result photo is posted so the chat stays clean. */
  statusMsgId?: number,
  /** True if this search consumed one of the daily free hits rather
   * than a paid credit. Used by the balance footer for transparency. */
  usedFree = false,
): Promise<void> {
  const sourceLabel =
    outcome.source === "memo"
      ? "⚡ Из памяти (мгновенно)"
      : outcome.source === "cache"
        ? "⚡ Из кеша"
        : `🔥 Живой поиск (${(outcome.elapsedMs / 1000).toFixed(1)}c, ${outcome.seedsTested.toLocaleString("ru-RU")} сидов, ~${Math.round(outcome.seedsTested / Math.max(1, outcome.elapsedMs / 1000)).toLocaleString("ru-RU")} сид/с)`;

  const { pins, legend } = buildPins(outcome);

  /* Telegram photo captions are capped at 1024 characters in HTML mode,
   * so we keep the caption terse: seed, source, legend, balance. The
   * map image carries the visual locations and the legend ties them
   * back to russian names. */
  const captionLines: string[] = [
    `🌍 <b>Сид:</b> <code>${outcome.seed}</code>`,
    sourceLabel,
    `📏 Радиус: ${radius} бл`,
  ];
  if (legend.length) {
    captionLines.push("", ...legend);
  }
  captionLines.push("", balanceFooter(user, charged, usedFree));
  let caption = captionLines.join("\n");
  if (caption.length > 1024) caption = caption.slice(0, 1020) + "…";

  if (!ctx.chat) return;
  try {
    /* Render the biome map PNG. radius * 1.3 gives a bit of headroom so
     * pins near the edge aren't cut off; size + scale are chosen
     * automatically in the map service. */
    const pngRadius = Math.max(128, Math.ceil(radius * 1.3));
    const png = await renderMapPng({
      seed: outcome.seed.toString(),
      mc,
      radius: pngRadius,
      pins,
    });
    /* Replace the status message with the photo so the chat stays clean. */
    const idsToDelete = new Set<number>();
    if (statusMsgId) idsToDelete.add(statusMsgId);
    const cbMsg = ctx.callbackQuery.message?.message_id;
    if (cbMsg) idsToDelete.add(cbMsg);
    for (const id of idsToDelete) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, id);
      } catch (err) {
        logger.debug({ err, id }, "could not delete status message");
      }
    }
    await ctx.api.sendPhoto(ctx.chat.id, new InputFile(png, "spawn.png"), {
      caption,
      parse_mode: "HTML",
      reply_markup: resultKeyboard(),
    });
  } catch (err) {
    /* PNG render failed — degrade gracefully to a text-only message so
     * the user still gets the seed + coords. */
    logger.warn({ err }, "map render failed; falling back to text");
    const biomeLines = outcome.biomes
      .map((b) => `• <b>${b.nameRu}</b> — ${b.x}, ${b.z}`)
      .join("\n");
    const structLines = outcome.structures
      .map((s) => `• <b>${s.nameRu}</b> — ${s.x}, ${s.z}`)
      .join("\n");
    const lines: string[] = [`🌍 <b>Сид:</b> <code>${outcome.seed}</code>`, "", sourceLabel];
    if (biomeLines) lines.push("", "🌳 <b>Биомы:</b>", biomeLines);
    if (structLines) lines.push("", "🏛 <b>Структуры:</b>", structLines);
    lines.push("", balanceFooter(user, charged, usedFree));
    const fallbackText = lines.join("\n");
    if (statusMsgId) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsgId, fallbackText, {
          parse_mode: "HTML",
          reply_markup: resultKeyboard(),
        });
        return;
      } catch (e) {
        logger.debug({ e }, "fallback edit failed; sending fresh");
      }
    }
    await ctx.api.sendMessage(ctx.chat.id, fallbackText, {
      parse_mode: "HTML",
      reply_markup: resultKeyboard(),
    });
  }
}

/** Once user finishes structures picker, this handler advances to radius. */
export async function handleStructuresContinue(
  ctx: CallbackQueryContext<Context>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("📏 Выбери радиус от спавна:", {
    reply_markup: radiusKeyboard(),
  });
}

export function isSearchCallback(data: string): boolean {
  return (
    data.startsWith("search:") ||
    data.startsWith("pick:") ||
    data === "noop"
  );
}
