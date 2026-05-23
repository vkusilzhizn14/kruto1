import { PACKS, PRESETS } from "@kruto52/shared";
import { InlineKeyboard, Keyboard } from "grammy";

/** Reply keyboard pinned at the bottom of every chat. */
export function mainReplyKeyboard(): Keyboard {
  return new Keyboard()
    .text("🔍 Найти сид")
    .text("⭐️ Пресеты")
    .row()
    .text("💎 Купить")
    .text("📜 История")
    .text("ℹ️ Помощь")
    .resized();
}

export function buyKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PACKS) {
    kb.text(`${p.nameRu} — ${p.stars}⭐️`, `buy:pack:${p.id}`).row();
  }
  kb.text("Оплатить криптой (USDT/TON)", "buy:crypto:menu");
  return kb;
}

export function presetsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PRESETS) {
    kb.text(`${p.emoji} ${p.nameRu}`, `preset:${p.id}`).row();
  }
  kb.text("🔧 Свой поиск", "search:restart");
  return kb;
}
