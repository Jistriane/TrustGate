export const LISTING_FEE_RATE = 0.005;

export function calculateListingFeeStroops(reservePriceStroops: bigint): bigint {
  return (reservePriceStroops * 5n + 500n) / 1000n;
}
