/**
 * /start onboarding handler.
 *
 * Shows the value proposition, available free quota, and a reply keyboard
 * with the main entry points (search, presets, buy, history, help).
 */

import type { CommandContext, Context } from "grammy";

import { config } from "../config.js";
import { mainReplyKeyboard } from "../keyboards/main.js";
import { upsertUser } from "../services/users.js";

export async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;
  await upsertUser({
    tgId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    language: ctx.from.language_code,
  });
  const lines = [
    `Привет, ${ctx.from.first_name ?? "игрок"}! 👋`,
    "",
    "🎮 Я ищу сиды Minecraft с нужными биомами и структурами прямо рядом со спавном.",
    "",
    `🎁 ${config.freeDailyHits} бесплатных поиска каждый день — кэш или живой движок, без разницы. Не сгорают, но и не копятся.`,
    "💎 Дальше — пакеты кредитов или Pro подписка с безлимитом.",
    "🆓 Когда поиски закончились, можно один раз активировать <b>Pro на 24 часа</b> бесплатно.",
    "",
    "👉 Жми «🔍 Найти сид» — соберём твой идеальный мир за секунды.",
  ];
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: mainReplyKeyboard(),
  });
}

export async function handleHelp(ctx: Context): Promise<void> {
  const lines = [
    "🧭 Как это работает:",
    "",
    "1️⃣ Выбираешь версию Minecraft (1.20 или 1.21)",
    "2️⃣ Отмечаешь нужные биомы (равнины, тёмный лес, вишнёвая роща, грибы…)",
    "3️⃣ Отмечаешь нужные структуры (деревня, особняк, древний город…)",
    "4️⃣ Выбираешь радиус: 100 / 200 / 500 / 1000 блоков от спавна",
    "5️⃣ Получаешь сид с координатами всего найденного — копируй и играй",
    "",
    "⚡ Большинство популярных запросов отдаются из готового кеша за миллисекунды.",
    "🔍 Редкие комбинации ищет наш C-движок на cubiomes в несколько потоков.",
    "💰 Кредит списывается только при успешной выдаче.",
    "",
    "Команды:",
    "/balance — текущий баланс кредитов и Pro-статус",
    "/speed — бенчмарк скорости поиска",
    "/history — последние запросы",
    "/buy — пакеты кредитов и Pro",
    "",
    "Вопросы / баги — пиши в личку владельцу бота.",
  ];
  await ctx.reply(lines.join("\n"));
}
