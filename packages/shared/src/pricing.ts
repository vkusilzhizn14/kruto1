/**
 * Pricing tiers for credit packs and the Pro subscription.
 *
 * All prices are quoted in Telegram Stars (XTR currency in the Bot Payments
 * API). CryptoBot equivalents use the matching `usdtPrice` value.
 *
 * One credit = one successful live search. Cache hits do NOT consume credits
 * by design (zero marginal cost on our side; promotes virality).
 *
 * Pack lineup (ПО ДОГОВОРУ 2026-05-28):
 *   • trial_10  — 10 кредитов за 30⭐, без подписки (стартовый порог)
 *   • pro_week  — 7 дней Pro безлимита за 50⭐ (средняя выгода)
 *   • pro_month — 30 дней Pro безлимита за 125⭐ (самый выгодный)
 *
 * Trial-24h выпилен полностью — порог входа теперь trial_10 пак.
 */

export type PackKind = "trial_10" | "pro_week" | "pro_month";

export interface Pack {
  readonly id: PackKind;
  readonly nameRu: string;
  readonly descRu: string;
  readonly stars: number;
  readonly usdtPrice: number;
  readonly credits: number;
  /** For Pro: duration in days; for credit packs: 0. */
  readonly subscriptionDays: number;
}

export const PACKS: readonly Pack[] = [
  {
    id: "trial_10",
    nameRu: "Пробный пак",
    descRu: "10 запросов — попробовать и понять нравится ли",
    stars: 30,
    usdtPrice: 0.59,
    credits: 10,
    subscriptionDays: 0,
  },
  {
    id: "pro_week",
    nameRu: "Подписка на неделю",
    descRu: "Безлимит живых поисков на 7 дней + приоритет очереди",
    stars: 50,
    usdtPrice: 0.99,
    credits: 0,
    subscriptionDays: 7,
  },
  {
    id: "pro_month",
    nameRu: "Подписка на месяц",
    descRu: "Безлимит живых поисков на 30 дней + приоритет очереди — самый выгодный",
    stars: 125,
    usdtPrice: 2.49,
    credits: 0,
    subscriptionDays: 30,
  },
] as const;

export function getPack(id: PackKind): Pack {
  const p = PACKS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown pack: ${id}`);
  return p;
}

/** Free quota: cache hits per day for non-paying users. */
export const FREE_DAILY_CACHE_HITS = 2;
