import { toMppNetworkId } from './mppCharge';

describe('toMppNetworkId', () => {
  it('maps pubnet to the pubnet CAIP-2 id', () => {
    expect(toMppNetworkId('pubnet')).toBe('stellar:pubnet');
  });

  it('maps testnet to the testnet CAIP-2 id', () => {
    expect(toMppNetworkId('testnet')).toBe('stellar:testnet');
  });

  it('falls back local to the testnet CAIP-2 id (closest supported network)', () => {
    expect(toMppNetworkId('local')).toBe('stellar:testnet');
  });
});
