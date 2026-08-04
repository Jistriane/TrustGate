import { USDC_DECIMALS } from './usdc';

export const DEFAULT_DAILY_USDC_LIMIT = 100;

/** Approximate ledgers per day at ~5s/ledger. */
export const LEDGERS_PER_DAY = 17280;

export interface DelegatedSigner {
  tag: 'Delegated';
  values: readonly [string];
}

/** A classic Stellar account (G...) authorized as a smart account signer. */
export function buildDelegatedSigner(publicKey: string): DelegatedSigner {
  return { tag: 'Delegated', values: [publicKey] };
}

/**
 * Constructor params for OpenZeppelin's `SpendingLimitAccountParams` (see
 * packages/accounts/src/policies/spending_limit.rs). The policy itself is
 * token-agnostic — scoping to a specific token (e.g. the USDC SAC) happens
 * at the context-rule level, not via a field on this struct.
 */
export interface SpendingLimitPolicyParams {
  spending_limit: bigint;
  period_ledgers: number;
}

/** Constructor params for a spending-limit policy capping daily spend. */
export function buildSpendingLimitPolicyParams(
  dailyLimitUsdc: number = DEFAULT_DAILY_USDC_LIMIT,
): SpendingLimitPolicyParams {
  return {
    spending_limit: BigInt(Math.round(dailyLimitUsdc * 10 ** USDC_DECIMALS)),
    period_ledgers: LEDGERS_PER_DAY,
  };
}
