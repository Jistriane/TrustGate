import { Asset } from '@stellar/stellar-sdk';
import { StellarConfig } from './stellar';

export const USDC_DECIMALS = 7;

export function getUsdcAsset(): Asset {
  const issuer = process.env.USDC_ISSUER;
  if (!issuer) {
    throw new Error('USDC_ISSUER is not set');
  }
  return new Asset('USDC', issuer);
}

export function getUsdcSacContractId(config: StellarConfig): string {
  return getUsdcAsset().contractId(config.networkPassphrase);
}
