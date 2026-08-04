import { USDC_DECIMALS } from '../config/usdc';

export const LISTING_FEE_RATE = 0.005;

/** 0.5% listing fee on a task's reserve price, rounded to USDC's 7 decimal places. */
export function calculateListingFee(reservePrice: number): number {
  const units = Math.round(reservePrice * LISTING_FEE_RATE * 10 ** USDC_DECIMALS);
  return units / 10 ** USDC_DECIMALS;
}
