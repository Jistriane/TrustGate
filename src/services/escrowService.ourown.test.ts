/**
 * src/services/escrowService.ourown.test.ts
 *
 * Unit tests for REAL OurOwnEscrowContractClient (P0-1 stage C).
 * Mocks stellar-sdk bindings to validate:
 *  (1) correct parameter assembly for each method
 *  (2) BP validation P0-7 in confiscate
 *  (3) taskId sha256 bytes32 in createEscrow/buildCreateEscrowXdr
 *  (4) factory DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL gate (security opt-in).
 */

import { createHash } from 'crypto';
import {
  OurOwnEscrowContractClient,
  createEscrowProvider,
  type OurOwnEscrowConfig,
  LocalKeypairSigner,
  type IMarketplaceSigner,
} from './escrowService';

jest.mock('../contracts/bindings/escrow/src/index', () => {
  class FakeAssembled<T> {
    result: T = undefined as T;
    constructor(public readonly method: string, public readonly args: unknown) {}
    toXDR() { return 'XDR_' + this.method; }
    async simulate() { return this; }
    async sign(_kp: unknown) { return this as unknown as FakeAssembled<T>; }
    async send(_opts?: unknown) {
      return {
        waitUntilDone: async () => ({ hash: 'MOCK_TX_HASH_' + this.method } as unknown),
      };
    }
  }
  return {
    Client: jest.fn().mockImplementation(() => ({
      create_escrow: jest.fn(async (args: unknown) => new FakeAssembled<string>('create_escrow', args)),
      release_milestone: jest.fn(async (_args: unknown) => new FakeAssembled<void>('release_milestone', undefined)),
      confiscate: jest.fn(async (args: unknown) => {
        const fa = new FakeAssembled<readonly [bigint, bigint]>('confiscate', args);
        fa.result = [3_500_000n, 1_500_000n] as const;
        return fa;
      }),
      claim_timeout: jest.fn(async (args: unknown) => {
        const fa = new FakeAssembled<readonly [bigint, string]>('claim_timeout', args);
        const EXEC_ADDR = ('G' + 'EXECUTORXYZABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOP').slice(0, 56);
        fa.result = [5_000_000n, EXEC_ADDR] as const;
        return fa;
      }),
      get_escrow: jest.fn(async () => {
        const EXEC = ('G' + 'EXECUTORXYZABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOP').slice(0, 56);
        const MKT = ('G' + 'MARKETPLACEABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKL').slice(0, 56);
        const fa = new FakeAssembled<{
          task_id_hash: string; executor: string; requester: string; release_signer: string;
          collateral: bigint; released: bigint; created_at_ledger: number; status: number;
        }>('get_escrow', undefined);
        fa.result = {
          task_id_hash: '0'.repeat(64),
          executor: EXEC,
          requester: MKT,
          release_signer: MKT,
          collateral: 5_000_000n,
          released: 0n,
          created_at_ledger: 1,
          status: 0,
        };
        return fa;
      }),
      initialize: jest.fn(async (args: unknown) => new FakeAssembled<void>('initialize', args)),
      pause: jest.fn(async () => new FakeAssembled<void>('pause', undefined)),
      unpause: jest.fn(async () => new FakeAssembled<void>('unpause', undefined)),
      is_paused: jest.fn(async () => {
        const fa = new FakeAssembled<number>('is_paused', undefined);
        fa.result = 0;
        return fa;
      }),
      transfer_pauser_ownership: jest.fn(async (args: unknown) => new FakeAssembled<void>('transfer_pauser_ownership', args)),
    })),
  };
});

jest.mock('@stellar/stellar-sdk', () => {
  class KP {
    constructor(private readonly sk: string) {}
    publicKey() {
      if (this.sk.includes('VALID_ADDRESS') || this.sk.includes('VALID')) {
        return ('G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2)).slice(0, 56);
      }
      return ('G' + this.sk.replace(/[^A-Z2-7]/g, 'X').padEnd(55, 'A')).slice(0, 56);
    }
    secret() { return this.sk; }
    sign(_buf: Uint8Array | Buffer) {
      return Buffer.from('MOCK_SIG_' + this.sk.slice(0, 8)).slice(0, 64);
    }
  }
  class Tx {
    constructor(private readonly xdr: string, _pp: string) { void _pp; }
    toXDR() { return 'SIGNED_' + this.xdr; }
    sign(_kp: unknown) { /* no-op mocked */ }
  }
  return {
    Keypair: {
      fromSecret: jest.fn((sk: string) => new KP(sk)),
      random: jest.fn(() => new KP('seed-' + Math.random().toString())),
    },
    hash: (buf: Buffer | Uint8Array) => createHash('sha256').update(buf).digest(),
    Transaction: Tx as unknown as any,
  };
});

const MOCK_STELLAR_ADDR_BASE = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55);
const DUMMY_SIGNER_SK = 'SCMARKETPLACE_SECRET_MOCK_VALID_ADDRESS';
function makeDummyCfg(overrides: Partial<OurOwnEscrowConfig> = {}): OurOwnEscrowConfig {
  return {
    network: 'local',
    escrowContractId: 'C' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55),
    tokenContract: 'C' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(1).padEnd(55, 'A'),
    marketplaceWallet: MOCK_STELLAR_ADDR_BASE,
    confiscateRequesterBp: 7000,
    stellarRpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: 'Standalone Network ; February 2024',
    marketplaceSigner: new LocalKeypairSigner(DUMMY_SIGNER_SK),
    rpcTimeoutMs: 3000,
    ...overrides,
  };
}
const DUMMY_CFG: OurOwnEscrowConfig = makeDummyCfg();

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.__EXECUTOR_SECRET_KEY_FOR_TEST_ONLY__;
});

function lastClient(): any {
  const { Client } = jest.requireMock('../contracts/bindings/escrow/src/index');
  return Client.mock.results[Client.mock.results.length - 1].value;
}

describe('P0-11 IMarketplaceSigner + LocalKeypairSigner default', () => {
  it('LocalKeypairSigner.getPublicKey() returns G...56 address matching expected', async () => {
    const signer = new LocalKeypairSigner(DUMMY_SIGNER_SK);
    const pk = await signer.getPublicKey();
    expect(pk.startsWith('G')).toBe(true);
    expect(pk).toHaveLength(56);
    expect(pk).toBe(MOCK_STELLAR_ADDR_BASE);
  });

  it('signTransaction returns signedXdr with SIGNED_ prefix and same signerPublicKey', async () => {
    const signer = new LocalKeypairSigner(DUMMY_SIGNER_SK);
    const res = await signer.signTransaction('XDR_UNSIGNED_TEST', DUMMY_CFG.networkPassphrase!);
    expect(res.signedXdr).toBe('SIGNED_XDR_UNSIGNED_TEST');
    expect(res.signerPublicKey).toBe(MOCK_STELLAR_ADDR_BASE);
  });

  it('createEscrowProvider with injectedMarketplaceSigner → uses injected signer (LocalKeypairSigner default NOT instantiated)', async () => {
    const customSigner: IMarketplaceSigner = {
      getPublicKey: jest.fn().mockResolvedValue(MOCK_STELLAR_ADDR_BASE),
      signTransaction: jest.fn().mockResolvedValue({ signedXdr: 'CUSTOM_SIGNED_XDR', signerPublicKey: MOCK_STELLAR_ADDR_BASE }),
      signAuthEntry: jest.fn().mockResolvedValue({ signedAuthEntryXdr: 'AA==', signerPublicKey: MOCK_STELLAR_ADDR_BASE }),
    };
    const VALID_MARKET_WALLET = MOCK_STELLAR_ADDR_BASE;
    const baseEnv = {
      ESCROW_CONTRACT_ID: 'C' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55),
      ESCROW_TOKEN_CONTRACT: 'C' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(1).padEnd(55, 'A'),
      MARKETPLACE_WALLET: VALID_MARKET_WALLET,
      ESCROW_CONFISCATE_REQUESTER_BP: 7000,
      DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL: 'true' as const,
    };
    const p = await createEscrowProvider({
      implementation: 'ourown',
      network: 'local',
      envOverrides: baseEnv,
      injectedMarketplaceSigner: customSigner,
    });
    expect(p).toBeInstanceOf(OurOwnEscrowContractClient);
    expect(customSigner.getPublicKey).toHaveBeenCalled();
  });
});

describe('OurOwnEscrowContractClient - correct parameterization', () => {
  it('buildCreateEscrowXdr: taskId → sha256 bytes32 length=32, collateral amount cast bigint', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    const taskId = 'task-abc-123';
    const expectedHash = createHash('sha256').update(taskId, 'utf8').digest();
    const res = await c.buildCreateEscrowXdr(
      'G' + 'A'.repeat(55),
      taskId,
      5_000_000,
    );
    expect(res.unsignedXdr).toBe('XDR_create_escrow');
    expect(res.expectedSigners).toHaveLength(1);
    const call = lastClient().create_escrow.mock.calls[lastClient().create_escrow.mock.calls.length - 1][0];
    expect(call.collateral_amount).toBe(5_000_000n);
    expect(Buffer.isBuffer(call.task_id_hash)).toBe(true);
    expect(call.task_id_hash.toString('hex')).toBe(expectedHash.toString('hex'));
    expect(call.release_signer).toBe(MOCK_STELLAR_ADDR_BASE);
    expect(call.token).toBe(DUMMY_CFG.tokenContract);
  });

  it('confiscate: share BP min 3000 (P0-7) → 29.99% fail, 0% fail, 30% passes', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    await expect(c.confiscate('e'.repeat(56), 0, 0.2999)).rejects.toThrow(/min 3000/);
    await expect(c.confiscate('e'.repeat(56), 0, 0)).rejects.toThrow(/min 3000/);
    const res = await c.confiscate('e'.repeat(56), 5_000_000, 0.3);
    expect(res.success).toBe(true);
    expect(Number.isFinite(res.requesterShare)).toBe(true);
  });

  it('releaseMilestone default (no amount) → remaining = collateral (5M) amountReleased=5M', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    const r = await c.releaseMilestone('a'.repeat(56));
    expect(r.success).toBe(true);
    expect(r.amountReleased).toBe(5_000_000);
    expect(r.receiver).toHaveLength(56);
    expect(r.receiver.startsWith('G')).toBe(true);
    expect(r.transactionHash).toBe('MOCK_TX_HASH_release_milestone');
    const cli = lastClient();
    const releaseCall = cli.release_milestone.mock.calls[cli.release_milestone.mock.calls.length - 1][0];
    expect(releaseCall.amount).toBe(5_000_000n);
  });

  it('P0-9 releaseMilestone partial amountUnits=2M → amountReleased=2M (remaining 3M)', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    const r = await c.releaseMilestone('a'.repeat(56), 2_000_000);
    expect(r.amountReleased).toBe(2_000_000);
    const cli = lastClient();
    const releaseCall = cli.release_milestone.mock.calls[cli.release_milestone.mock.calls.length - 1][0];
    expect(releaseCall.amount).toBe(2_000_000n);
  });

  it('P0-9 releaseMilestone amountUnits > remaining (6M > 5M) → reject "exceeds remaining"', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    await expect(c.releaseMilestone('a'.repeat(56), 6_000_000)).rejects.toThrow(/excede remaining/);
  });

  it('P0-9 releaseMilestone amountUnits 0 / negative / float → reject positive integer', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    await expect(c.releaseMilestone('a'.repeat(56), 0)).rejects.toThrow(/integer positivo/);
    await expect(c.releaseMilestone('a'.repeat(56), -100)).rejects.toThrow(/integer positivo/);
    await expect(c.releaseMilestone('a'.repeat(56), 1.5)).rejects.toThrow(/integer positivo/);
  });

  it('collateral amount non-integer/zero/negative → reject', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    await expect(c.buildCreateEscrowXdr('G'.repeat(56), 't1', 1.5)).rejects.toThrow(/positive integer/);
    await expect(c.buildCreateEscrowXdr('G'.repeat(56), 't1', 0)).rejects.toThrow(/positive integer/);
    await expect(c.buildCreateEscrowXdr('G'.repeat(56), 't1', -1)).rejects.toThrow(/positive integer/);
  });

  it('admin: initialize() calls binding initialize with token, release_signer and marketplace=release_signer default (3rd arg)', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    const r = await c.initialize(DUMMY_CFG.tokenContract!, MOCK_STELLAR_ADDR_BASE);
    expect(r.alreadyInitialized).toBe(false);
    const cli = lastClient();
    const initCall = cli.initialize.mock.calls[cli.initialize.mock.calls.length - 1][0];
    expect(initCall.token).toBe(DUMMY_CFG.tokenContract);
    expect(initCall.release_signer).toBe(MOCK_STELLAR_ADDR_BASE);
    expect(initCall.marketplace).toBe(MOCK_STELLAR_ADDR_BASE);
  });

  it('admin: pause() + unpause() + transferPauser() assemble correct args', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    const pr = await c.pause();
    expect(pr.wasAlreadyPaused).toBe(false);
    const upr = await c.unpause();
    expect(upr.wasAlreadyUnpaused).toBe(false);
    const NEW_PAUSER = 'G' + 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'.slice(0, 55);
    const tr = await c.transferPauser(NEW_PAUSER);
    expect(tr.newPauser).toBe(NEW_PAUSER);
    const cli = lastClient();
    expect(cli.transfer_pauser_ownership.mock.calls).toHaveLength(1);
    const tpc = cli.transfer_pauser_ownership.mock.calls[0][0];
    expect(tpc.new_pauser).toBe(NEW_PAUSER);
  });

  it('P1-3 PAUSE_ESCROW env flag = true → blocks createEscrow/release/confiscate/initialize/transferPauser but does NOT block unpause', async () => {
    const cfgPaused = makeDummyCfg({ pauseEscrowFeatureFlag: true });
    const c = new OurOwnEscrowContractClient(cfgPaused);
    await expect(c.createEscrow('G'.repeat(56), 't1', 1000, 'EXEC_SK_DEV')).rejects.toThrow(/PAUSE_ESCROW env flag=1/);
    await expect(c.releaseMilestone('a'.repeat(56))).rejects.toThrow(/PAUSE_ESCROW env flag=1/);
    await expect(c.confiscate('a'.repeat(56), 0, 0.5)).rejects.toThrow(/PAUSE_ESCROW env flag=1/);
    await expect(c.initialize('T', 'G'.repeat(56))).rejects.toThrow(/PAUSE_ESCROW env flag=1/);
    await expect(c.transferPauser('G'.repeat(56))).rejects.toThrow(/PAUSE_ESCROW env flag=1/);
    const unpauseR = await c.unpause();
    expect(typeof unpauseR.transactionHash).toBe('string');
  });

  it('P0-2/P0-6 claimTimeout happy path: transfers remaining=collateral-released TO EXECUTOR permissionless', async () => {
    const c = new OurOwnEscrowContractClient(DUMMY_CFG);
    delete process.env.__EXECUTOR_SECRET_KEY_FOR_TEST_ONLY__;
    const r = await c.claimTimeout('CE-SOME-ESCROW-ID-1234567890123456789012345678');
    expect(typeof r.transactionHash).toBe('string');
    expect(r.amountTransferred).toBe(5_000_000n);
    expect(r.beneficiary.length).toBe(56);
    expect(r.beneficiary.startsWith('G')).toBe(true);
    const cli = lastClient();
    expect(cli.claim_timeout.mock).toBeDefined();
    const ctCalls = cli.claim_timeout.mock.calls;
    expect(ctCalls.length).toBeGreaterThanOrEqual(1);
    expect(ctCalls[ctCalls.length - 1][0].escrow_id).toBeDefined();
  });
});

describe('createEscrowProvider: DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL gate (security)', () => {
  const VALID_MARKET_WALLET = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55);
  const VALID_MARKET_SECRET = DUMMY_SIGNER_SK;
  const baseEnv = {
    ESCROW_CONTRACT_ID: 'C' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55),
    ESCROW_TOKEN_CONTRACT: 'C' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(1).padEnd(55, 'A'),
    MARKETPLACE_WALLET: VALID_MARKET_WALLET,
    MARKETPLACE_SECRET_KEY: VALID_MARKET_SECRET,
    ESCROW_CONFISCATE_REQUESTER_BP: 7000,
  };

  it('WITH opt-in TRUE → instantiates REAL OurOwnEscrowContractClient (not the STUB)', async () => {
    const p = await createEscrowProvider({
      implementation: 'ourown',
      network: 'local',
      envOverrides: { ...baseEnv, DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL: 'true' },
    });
    expect(p).toBeInstanceOf(OurOwnEscrowContractClient);
  });

  it('WITHOUT opt-in (flag "false" or absent) → SAFE STUB, throws on createEscrow with "SAFE STUB"', async () => {
    const pFalse = await createEscrowProvider({
      implementation: 'ourown',
      network: 'local',
      envOverrides: { ...baseEnv, DEBUG_UNSAFE_ENABLE_OWN_ESCROW_IMPL: 'false' },
    });
    expect(pFalse).not.toBeInstanceOf(OurOwnEscrowContractClient);
    await expect(pFalse.createEscrow('G1', 't1', 1000)).rejects.toThrow(/SAFE STUB/);

    const pMissing = await createEscrowProvider({
      implementation: 'ourown',
      network: 'local',
      envOverrides: baseEnv,
    });
    expect(pMissing).not.toBeInstanceOf(OurOwnEscrowContractClient);
    await expect(pMissing.createEscrow('G1', 't1', 1000)).rejects.toThrow(/SAFE STUB/);
  });

  it('STUB also blocks new admin methods (initialize/pause/unpause/transferPauser/claimTimeout/isPaused)', async () => {
    const p = await createEscrowProvider({
      implementation: 'ourown',
      network: 'local',
      envOverrides: baseEnv,
    });
    await expect((p as any).initialize?.()).rejects.toThrow(/SAFE STUB/);
    await expect((p as any).pause?.()).rejects.toThrow(/SAFE STUB/);
    await expect((p as any).unpause?.()).rejects.toThrow(/SAFE STUB/);
    await expect((p as any).transferPauser?.('G')).rejects.toThrow(/SAFE STUB/);
    await expect((p as any).claimTimeout?.('e')).rejects.toThrow(/SAFE STUB/);
    await expect((p as any).isPaused?.()).rejects.toThrow(/SAFE STUB/);
  });
});
