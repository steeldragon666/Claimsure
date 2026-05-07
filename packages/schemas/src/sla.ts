import { z } from 'zod';

/**
 * SLA service tier (P9.2.1).
 *
 * Three tiers of quarterly SLA retainer:
 *   bronze: $750/quarter  — solo to 2-person firm
 *   silver: $2,500/quarter — 3 to 10-person firm
 *   gold:   $7,500/quarter — 11+ person firm
 *
 * Tier rank is used to classify plan changes as upgrade or downgrade.
 */
export const SlaTierEnum = z.enum(['bronze', 'silver', 'gold']);
export type SlaTier = z.infer<typeof SlaTierEnum>;

/**
 * Ordinal rank for each tier (bronze=1 lowest, gold=3 highest).
 * Used by the plan-change endpoint to determine proration behaviour.
 */
export const SLA_TIER_RANK: Record<SlaTier, number> = {
  bronze: 1,
  silver: 2,
  gold: 3,
};

/**
 * Environment variable name that holds the Stripe price ID for each tier.
 * Resolved at request time so the server can be configured per-environment.
 */
export const SLA_TIER_PRICE_ENV: Record<SlaTier, string> = {
  bronze: 'STRIPE_PRICE_ID_SLA_BRONZE',
  silver: 'STRIPE_PRICE_ID_SLA_SILVER',
  gold: 'STRIPE_PRICE_ID_SLA_GOLD',
};
