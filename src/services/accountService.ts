import { Horizon } from '@stellar/stellar-sdk';
import { StellarConfig } from '../config/stellar';

export interface AccountBalance {
  assetType: string;
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
}

export class AccountService {
  private readonly server: Horizon.Server;

  constructor(config: StellarConfig) {
    this.server = new Horizon.Server(config.horizonUrl, { allowHttp: config.allowHttp });
  }

  async getBalances(publicKey: string): Promise<AccountBalance[]> {
    const account = await this.server.loadAccount(publicKey);
    return account.balances.map((b) => ({
      assetType: b.asset_type,
      assetCode: 'asset_code' in b ? b.asset_code : undefined,
      assetIssuer: 'asset_issuer' in b ? b.asset_issuer : undefined,
      balance: b.balance,
    }));
  }

  async getXlmBalance(publicKey: string): Promise<string> {
    const balances = await this.getBalances(publicKey);
    const native = balances.find((b) => b.assetType === 'native');
    return native?.balance ?? '0';
  }

  async getUsdcBalance(publicKey: string, usdcIssuer: string): Promise<string> {
    const balances = await this.getBalances(publicKey);
    const usdc = balances.find((b) => b.assetCode === 'USDC' && b.assetIssuer === usdcIssuer);
    return usdc?.balance ?? '0';
  }
}
