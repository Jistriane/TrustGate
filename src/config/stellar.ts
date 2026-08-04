import { Networks } from '@stellar/stellar-sdk';

export type StellarNetwork = 'local' | 'testnet' | 'pubnet';

export interface StellarConfig {
  network: StellarNetwork;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  /** Plain HTTP is only ever acceptable against local/testnet infra, never pubnet. */
  allowHttp: boolean;
}

function passphraseFor(network: StellarNetwork): string {
  switch (network) {
    case 'testnet':
      return Networks.TESTNET;
    case 'pubnet':
      return Networks.PUBLIC;
    case 'local':
    default:
      return Networks.STANDALONE;
  }
}

export function loadStellarConfig(): StellarConfig {
  const network = (process.env.NETWORK as StellarNetwork) || 'local';
  return {
    network,
    rpcUrl: process.env.STELLAR_RPC_URL || 'http://localhost:8000/soroban/rpc',
    horizonUrl: process.env.STELLAR_HORIZON_URL || 'http://localhost:8000',
    networkPassphrase: passphraseFor(network),
    allowHttp: network !== 'pubnet',
  };
}
