import { AccountService } from './accountService';
import { loadStellarConfig } from '../config/stellar';

const mockBalancesByPublicKey = new Map<string, any[]>();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  class FakeServer {
    constructor(_horizonUrl: string, _opts?: any) {}
    async loadAccount(pk: string) {
      const balances = mockBalancesByPublicKey.get(pk);
      if (balances) return { balances };
      const err: any = new Error('ResourceMissingError');
      err.name = 'NotFoundError';
      err.status = 404;
      throw err;
    }
  }
  return {
    ...actual,
    Horizon: { Server: FakeServer },
  };
});

describe('AccountService', () => {
  beforeEach(() => mockBalancesByPublicKey.clear());

  it('getBalances returns loadAccount array mapped to interface', async () => {
    const cfg = loadStellarConfig();
    const svc = new AccountService(cfg);
    const pk = 'GACCT1' + 'A'.repeat(51);
    mockBalancesByPublicKey.set(pk, [
      { asset_type: 'native', balance: '100.5' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GUSDC' + 'A'.repeat(51), balance: '800.0' },
    ]);
    const balances = await svc.getBalances(pk);
    expect(balances.length).toBe(2);
    expect(balances[0].assetType).toBe('native');
    expect(balances[1].assetCode).toBe('USDC');
    expect(balances[1].assetIssuer).toBe('GUSDC' + 'A'.repeat(51));
  });

  it('getXlmBalance returns native balance and returns 0 when no native entry in balances', async () => {
    const cfg = loadStellarConfig();
    const svc = new AccountService(cfg);
    mockBalancesByPublicKey.set('GACCT2' + 'A'.repeat(51), [{ asset_type: 'native', balance: '50.123' }]);
    mockBalancesByPublicKey.set('GACCT2NOXLM' + 'A'.repeat(45), [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GUS', balance: '10' }]);
    expect(await svc.getXlmBalance('GACCT2' + 'A'.repeat(51))).toBe('50.123');
    expect(await svc.getXlmBalance('GACCT2NOXLM' + 'A'.repeat(45))).toBe('0');
  });

  it('getUsdcBalance filters by (assetCode=USDC + exact issuer) and falls to 0 on miss', async () => {
    const cfg = loadStellarConfig();
    const svc = new AccountService(cfg);
    mockBalancesByPublicKey.set('GACCT3' + 'A'.repeat(51), [
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GUSDCISSUER', balance: '123.456' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GFAKEISSUER', balance: '999' },
    ]);
    mockBalancesByPublicKey.set('GNOUSDC' + 'A'.repeat(50), [
      { asset_type: 'native', balance: '10' },
    ]);
    const usdc = await svc.getUsdcBalance('GACCT3' + 'A'.repeat(51), 'GUSDCISSUER');
    expect(usdc).toBe('123.456');
    expect(await svc.getUsdcBalance('GACCT3' + 'A'.repeat(51), 'GNOTEXIST')).toBe('0');
    expect(await svc.getUsdcBalance('GNOUSDC' + 'A'.repeat(50), 'GUSDCISSUER')).toBe('0');
  });
});
