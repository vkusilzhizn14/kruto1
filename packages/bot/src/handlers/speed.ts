/**
 * /speed — quick benchmark of the live worker.
 *
 * Runs a fixed `cherry_grove + mansion @ radius 100` query (rare combo,
 * guaranteed to burn through the seed budget) and reports the observed
 * seeds-per-second rate. Gives the user (and the operator) an at-a-glance
 * sense of how fast the parser is on this machine.
 */

import type { CommandContext, Context } from "grammy";

import { runWorker } from "../services/worker.js";

const BENCH_TIMEOUT_MS = 3_000;
const BENCH_MAX_SEEDS = 50_000_000;

export async function handleSpeed(ctx: CommandContext<Context>): Promise<void> {
  const status = await ctx.reply("⏱ Запускаю бенчмарк (3 секунды)…");
  const job = runWorker({
    id: `bench-${Date.now()}`,
    mc: "1.21",
    large_biomes: false,
    radius: 100,
    biomes: ["cherry_grove"],
    structures: ["mansion"],
    exclude_seeds: [],
    max_seeds: BENCH_MAX_SEEDS,
    timeout_ms: BENCH_TIMEOUT_MS,
  });
  const outcome = await job.wait();
  let testedNum = 0;
  let elapsedMs = 0;
  if (outcome.kind === "result") {
    testedNum = Number(outcome.message.seeds_tested);
    elapsedMs = Number(outcome.message.elapsed_ms);
  } else if (outcome.kind === "not_found") {
    testedNum = Number(outcome.message.seeds_tested);
    elapsedMs = Number(outcome.message.elapsed_ms);
  }
  const rate = elapsedMs > 0 ? Math.round((testedNum * 1000) / elapsedMs) : 0;
  const lines = [
    "⚡ <b>Скорость воркера</b>",
    "",
    `Тест: cherry_grove + mansion @ 100 блоков`,
    `Проверено: <b>${testedNum.toLocaleString("ru-RU")}</b> сидов`,
    `За: <b>${(elapsedMs / 1000).toFixed(2)} с</b>`,
    `Скорость: <b>${rate.toLocaleString("ru-RU")}</b> сид/с`,
  ];
  await ctx.api.editMessageText(status.chat.id, status.message_id, lines.join("\n"), {
    parse_mode: "HTML",
  });
}
