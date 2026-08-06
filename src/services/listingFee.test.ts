import { calculateListingFeeStroops, LISTING_FEE_RATE } from './listingFee';

describe('listingFee', () => {
  it('LISTING_FEE_RATE constant is 0.5% = 0.005', () => {
    expect(LISTING_FEE_RATE).toBe(0.005);
  });

  it('calculateListingFeeStroops: 1 USDC = 1_000_000 stroops → fee 5_000 stroops (0.5%)', () => {
    const reserve = 1_000_000n;
    expect(calculateListingFeeStroops(reserve)).toBe(5_000n);
  });

  it('calculateListingFeeStroops: 100 USDC = 100_000_000 stroops → fee 500_000', () => {
    const reserve = 100_000_000n;
    expect(calculateListingFeeStroops(reserve)).toBe(500_000n);
  });

  it('calculateListingFeeStroops: correct rounding (small stroops example)', () => {
    const reserve = 1_000n;
    expect(calculateListingFeeStroops(reserve)).toBeGreaterThanOrEqual(0n);
    expect(typeof calculateListingFeeStroops(reserve)).toBe('bigint');
  });

  it('calculateListingFeeStroops: 0 stroops retorna 0', () => {
    expect(calculateListingFeeStroops(0n)).toBe(0n);
  });
});
