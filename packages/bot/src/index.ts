/**
 * Bot entrypoint.
 *
 * Wires together:
 *   • grammY bot with HTTP/HTTPS proxy support (for RU server deploys)
 *   • Long-polling runner (no public IP required)
 *   • Postgres migrations on boot
 *   • Adaptive precompute scheduler
 *
 * No webhook server is required for MVP — long-polling on a residential
 * Russian VPS just needs outbound 443.
 */

import { Bot, GrammyError, HttpError } from "grammy";
import { run } from "@grammyjs/runner";
import { ProxyAgent, setGlobalDispatcher } from "undici";

import { config } from "./config.js";
import { logger } from "./logger.js";

import {
  handleAdminHelp,
  handleGrantCredits,
  handleGrantPro,
  handleRevokeCredits,
  handleRevokePro,
  handleSetCredits,
  handleWhois,
} from "./handlers/admin.js";
import { handleBalance } from "./handlers/balance.js";
import { handleBuyCallback, handleBuyCommand, handlePreCheckout, handleSuccessfulPayment } from "./handlers/buy.js";
import { handleHelp, handleStart } from "./handlers/start.js";
import { handleHistory } from "./handlers/history.js";
import {
  handlePreset,
  handlePresetsMenu,
  handleSearchCallback,
  handleSearchCommand,
  isSearchCallback,
} from "./handlers/search.js";
import { handleSpeed } from "./handlers/speed.js";
import { handleStats } from "./handlers/stats.js";
import { PRO_TRIAL_CALLBACK, handleProTrialActivate } from "./handlers/trial.js";
import { rateLimit } from "./middleware/rate_limit.js";
import { migrate } from "./services/db.js";
import { startHealthServer } from "./services/health.js";
import { startPrecomputeLoop } from "./services/precompute_scheduler.js";

// --- Proxy ---
if (config.proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(config.proxyUrl));
  logger.info({ proxy: config.proxyUrl }, "outbound proxy configured");
}

// --- Bot setup ---
const bot = new Bot(config.botToken);

bot.catch((err) => {
  if (err.error instanceof GrammyError) {
    logger.error({ err: err.error.description }, "telegram api error");
  } else if (err.error instanceof HttpError) {
    logger.error({ err: err.error.message }, "telegram network error");
  } else {
    logger.error({ err: err.error }, "uncaught bot error");
  }
});

// Global per-user rate limit (token bucket) — applies to every update.
bot.use(rateLimit);

bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("search", handleSearchCommand);
bot.command("history", handleHistory);
bot.command("buy", handleBuyCommand);
bot.command("balance", handleBalance);
bot.command("speed", handleSpeed);
bot.command("stats", handleStats);
bot.command("admin", handleAdminHelp);
bot.command("grant_credits", handleGrantCredits);
bot.command("revoke_credits", handleRevokeCredits);
bot.command("set_credits", handleSetCredits);
bot.command("grant_pro", handleGrantPro);
bot.command("revoke_pro", handleRevokePro);
bot.command("whois", handleWhois);

bot.hears("🔍 Найти сид", handleSearchCommand);
bot.hears("⭐️ Пресеты", handlePresetsMenu);
bot.hears("💎 Купить", handleBuyCommand);
bot.hears("📜 История", handleHistory);
bot.hears("ℹ️ Помощь", handleHelp);

bot.callbackQuery(/^preset:/, async (ctx) => {
  if (ctx.callbackQuery.data === "preset:menu") {
    await ctx.answerCallbackQuery();
    await handlePresetsMenu(ctx as never);
    return;
  }
  await handlePreset(ctx);
});

bot.callbackQuery(/^buy:/, handleBuyCallback);
bot.callbackQuery(PRO_TRIAL_CALLBACK, handleProTrialActivate);

bot.callbackQuery(/^(search|pick|noop)/, async (ctx) => {
  if (isSearchCallback(ctx.callbackQuery.data ?? "")) {
    await handleSearchCallback(ctx);
  }
});

bot.on("pre_checkout_query", handlePreCheckout);
bot.on("message:successful_payment", handleSuccessfulPayment);

async function main(): Promise<void> {
  await migrate();
  logger.info("migrations applied");
  startHealthServer();
  startPrecomputeLoop();
  const runner = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query", "pre_checkout_query"] } } });
  logger.info({ workerPath: config.workerPath, precomputePath: config.precomputePath }, "bot started");
  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "shutting down");
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "bot failed to start");
  process.exit(1);
});
