import { Keypair } from '@stellar/stellar-sdk';
import { SmartAccountService } from './smartAccountService';
import { loadStellarConfig } from '../config/stellar';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Keypair: actual.Keypair,
    contract: {
      ...(actual.contract ?? {}),
      basicNodeSigner: jest.fn(() => ({
        signTransaction: jest.fn(),
        signAuthEntry: jest.fn(),
      })),
      Client: {
        deploy: jest.fn(async () => {
          const assembled = {
            signAndSend: jest.fn(async () => ({
              result: { options: { contractId: 'C' + 'SMARTACCOUNTID' + 'A'.repeat(39) } },
            })),
          };
          return assembled;
        }),
      },
    },
  };
});

function makeSigner(): Keypair {
  return Keypair.random();
}

describe('SmartAccountService', () => {
  it('deployForRequester returns contractId starting with C (Soroban contract id)', async () => {
    const cfg = loadStellarConfig();
    const svc = new SmartAccountService(cfg, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const requester = makeSigner();
    const contractId = await svc.deployForRequester(requester);
    expect(contractId.startsWith('C')).toBe(true);
    expect(contractId.length).toBeGreaterThan(50);
  });
});
