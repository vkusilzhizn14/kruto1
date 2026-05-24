/**
 * Pricing tiers for credit packs and the Pro subscription.
 *
 * All prices are quoted in Telegram Stars (XTR currency in the Bot Payments
 * API). CryptoBot equivalents use the matching `usdtPrice` value.
 *
 * One credit = one successful live search. Cache hits do NOT consume credits
 * by design (zero marginal cost on our side; promotes virality).
 */

export type PackKind = "small" | "large" | "pro_month";

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
    id: "small",
    nameRu: "Малый пак",
    descRu: "15 живых поисков — на пару вечеров",
    stars: 10,
    usdtPrice: 0.2,
    credits: 15,
    subscriptionDays: 0,
  },
  {
    id: "large",
    nameRu: "Большой пак",
    descRu: "100 живых поисков — самый выгодный",
    stars: 49,
    usdtPrice: 0.99,
    credits: 100,
    subscriptionDays: 0,
  },
  {
    id: "pro_month",
    nameRu: "Pro подписка",
    descRu: "Безлимит живых поисков, приоритет очереди и расширенные фильтры на 30 дней",
    stars: 30,
    usdtPrice: 0.59,
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
