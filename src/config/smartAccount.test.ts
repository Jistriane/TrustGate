import {
  DEFAULT_DAILY_USDC_LIMIT,
  LEDGERS_PER_DAY,
  buildDelegatedSigner,
  buildSpendingLimitPolicyParams,
} from './smartAccount';

describe('buildDelegatedSigner', () => {
  it('wraps a public key as a Delegated signer', () => {
    const publicKey = 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO';
    expect(buildDelegatedSigner(publicKey)).toEqual({
      tag: 'Delegated',
      values: [publicKey],
    });
  });
});

describe('buildSpendingLimitPolicyParams', () => {
  it('defaults to a 100 USDC daily limit', () => {
    const params = buildSpendingLimitPolicyParams();
    expect(params.spending_limit).toBe(BigInt(DEFAULT_DAILY_USDC_LIMIT * 10 ** 7));
    expect(params.period_ledgers).toBe(LEDGERS_PER_DAY);
  });

  it('supports a custom daily limit', () => {
    const params = buildSpendingLimitPolicyParams(50);
    expect(params.spending_limit).toBe(BigInt(50 * 10 ** 7));
  });
});
