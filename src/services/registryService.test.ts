import { Keypair, contract } from '@stellar/stellar-sdk';
import { RegistryService, ExecutorInfo } from './registryService';
import { StellarConfig } from '../config/stellar';

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

  type LastCall = { method: string; args: Record<string, unknown>; signerPublicKey?: string };
  let lastCalls: LastCall[] = [];
  let registeredStore = new Map<string, ExecutorInfo>();

  const makeFakeAssembled = <T>(result: T) => ({
    result,
    signAndSend: jest.fn(async function (this: unknown) {
      return { result };
    }),
    sign: jest.fn(),
    send: jest.fn(async () => ({ waitUntilDone: jest.fn() })),
  });

  const makeClient = (opts?: { publicKey?: string }) => ({
    register_executor: jest.fn(async (args: { executor: string; metadata_uri: string }) => {
      lastCalls.push({ method: 'register_executor', args, signerPublicKey: opts?.publicKey });
      registeredStore.set(args.executor, {
        metadata_uri: args.metadata_uri,
        registered_at_ledger: 12345,
        updated_at_ledger: 12345,
      });
      return makeFakeAssembled({
        isOk: () => true,
        isErr: () => false,
        unwrap: () => undefined,
      });
    }),
    update_executor: jest.fn(async (args: { executor: string; profile_uri: string }) => {
      lastCalls.push({ method: 'update_executor', args, signerPublicKey: opts?.publicKey });
      const existing = registeredStore.get(args.executor);
      if (existing) {
        registeredStore.set(args.executor, { ...existing, profile_uri: args.profile_uri, updated_at_ledger: 12399 });
      }
      return makeFakeAssembled({
        isOk: () => true,
        isErr: () => false,
        unwrap: () => undefined,
      });
    }),
    unregister_executor: jest.fn(async (args: { executor: string }) => {
      lastCalls.push({ method: 'unregister_executor', args, signerPublicKey: opts?.publicKey });
      registeredStore.delete(args.executor);
      return makeFakeAssembled({
        isOk: () => true,
        isErr: () => false,
        unwrap: () => undefined,
      });
    }),
    is_registered: jest.fn(async (args: { executor: string }) => {
      lastCalls.push({ method: 'is_registered', args });
      return makeFakeAssembled(registeredStore.has(args.executor));
    }),
    get_executor: jest.fn(async (args: { executor: string }) => {
      lastCalls.push({ method: 'get_executor', args });
      const info = registeredStore.get(args.executor);
      if (!info) {
        return makeFakeAssembled({
          isOk: () => false,
          isErr: () => true,
          unwrapErr: () => ({ message: 'not registered' }),
        });
      }
      return makeFakeAssembled({
        isOk: () => true,
        isErr: () => false,
        unwrap: () => info,
      });
    }),
  });

  return {
    Keypair: {
      fromSecret: jest.fn((sk: string) => new KP(sk)),
      random: jest.fn(() => new KP('seed-' + Math.random().toString())),
    },
    contract: {
      Client: {
        from: jest.fn(async (opts: { publicKey?: string }) => makeClient({ publicKey: opts.publicKey })),
      },
      basicNodeSigner: jest.fn((_kp: unknown, _networkPassphrase: string) => ({
        signTransaction: jest.fn(async (xdr: string) => ({ signedTxXdr: 'SIGNED_' + xdr })),
        signAuthEntry: jest.fn(async (xdr: string) => ({ signedAuthEntryXdr: 'AUTH_' + xdr })),
      })),
      __testInternals: {
        resetCalls: () => { lastCalls = []; },
        lastCalls: () => lastCalls,
        resetStore: () => { registeredStore = new Map(); },
        getStore: () => registeredStore,
      },
    },
  };
});

const DUMMY_CFG: StellarConfig = {
  network: 'local',
  rpcUrl: 'https://rpc.example.com',
  horizonUrl: 'https://horizon.example.com',
  networkPassphrase: 'Test SDF Network ; September 2015',
  allowHttp: true,
};
const DUMMY_CONTRACT_ID = 'CREGISTRY000000000000000000000000000000000000000000000';
const DUMMY_EXECUTOR_SEED = 'SCLOSEDEXECUTORSEEDVALID000000000000000000000000000000000VALID';

describe('RegistryService (P1-1 lifecycle + P1-3 PAUSE_REGISTRY)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (contract as any).__testInternals.resetCalls();
    (contract as any).__testInternals.resetStore();
  });

  function makeService(envOverrides?: Partial<{ PAUSE_REGISTRY: 'true' | 'false' }>) {
    return new RegistryService(DUMMY_CFG, DUMMY_CONTRACT_ID, envOverrides);
  }

  function lastCallsBackdoor() {
    return (contract as any).__testInternals.lastCalls() as Array<{ method: string; args: Record<string, unknown> }>;
  }

  it('registerExecutor happy path: calls register_executor on-chain with correct pk and metadata_uri', async () => {
    const svc = makeService();
    const executor = Keypair.fromSecret(DUMMY_EXECUTOR_SEED);
    await svc.registerExecutor(executor, 'ipfs://QmMeta123');

    const calls = lastCallsBackdoor();
    const registerCall = calls.find(c => c.method === 'register_executor');
    expect(registerCall).toBeDefined();
    expect(registerCall!.args.executor).toBe(executor.publicKey());
    expect(registerCall!.args.metadata_uri).toBe('ipfs://QmMeta123');

    await expect(svc.isRegistered(executor.publicKey())).resolves.toBe(true);
    const info = await svc.getExecutor(executor.publicKey());
    expect(info.metadata_uri).toBe('ipfs://QmMeta123');
    expect(info.registered_at_ledger).toBe(12345);
  });

  it('updateExecutor happy path: valid profileUri calls update_executor', async () => {
    const svc = makeService();
    const executor = Keypair.fromSecret(DUMMY_EXECUTOR_SEED);
    await svc.registerExecutor(executor, 'ipfs://QmMeta123');

    const profileUri = 'https://example.com/executor-profile-v2.json';
    await svc.updateExecutor(executor, profileUri);

    const calls = lastCallsBackdoor();
    const updateCall = calls.find(c => c.method === 'update_executor');
    expect(updateCall).toBeDefined();
    expect(updateCall!.args.executor).toBe(executor.publicKey());
    expect(updateCall!.args.profile_uri).toBe(profileUri);

    const info = await svc.getExecutor(executor.publicKey());
    expect(info.profile_uri).toBe(profileUri);
    expect(info.updated_at_ledger).toBe(12399);
  });

  it('updateExecutor empty profileUri → throws ProfileUriEmpty=3 error without calling on-chain', async () => {
    const svc = makeService();
    const executor = Keypair.fromSecret(DUMMY_EXECUTOR_SEED);
    await svc.registerExecutor(executor, 'ipfs://QmMeta123');
    (contract as any).__testInternals.resetCalls();

    await expect(svc.updateExecutor(executor, '')).rejects.toThrow(/profileUri vazio proibido.*ProfileUriEmpty=3/);

    const callsAfter = lastCallsBackdoor();
    expect(callsAfter.find(c => c.method === 'update_executor')).toBeUndefined();
  });

  it('updateExecutor profileUri 4097 bytes (> 4096) → throws ProfileUriTooLong=4 without calling on-chain', async () => {
    const svc = makeService();
    const executor = Keypair.fromSecret(DUMMY_EXECUTOR_SEED);
    await svc.registerExecutor(executor, 'ipfs://QmMeta123');
    (contract as any).__testInternals.resetCalls();

    const tooLong = 'A'.repeat(4097);
    await expect(svc.updateExecutor(executor, tooLong)).rejects.toThrow(/ProfileUriTooLong=4/);

    const callsAfter = lastCallsBackdoor();
    expect(callsAfter.find(c => c.method === 'update_executor')).toBeUndefined();
  });

  it('unregisterExecutor happy path: calls unregister_executor and removes from store', async () => {
    const svc = makeService();
    const executor = Keypair.fromSecret(DUMMY_EXECUTOR_SEED);
    await svc.registerExecutor(executor, 'ipfs://QmMeta123');
    await expect(svc.isRegistered(executor.publicKey())).resolves.toBe(true);

    await svc.unregisterExecutor(executor);

    const calls = lastCallsBackdoor();
    const unregCall = calls.find(c => c.method === 'unregister_executor');
    expect(unregCall).toBeDefined();
    expect(unregCall!.args.executor).toBe(executor.publicKey());

    await expect(svc.isRegistered(executor.publicKey())).resolves.toBe(false);
    await expect(svc.getExecutor(executor.publicKey())).rejects.toThrow(/not registered/);
  });

  it('P1-3 PAUSE_REGISTRY=true → mutations (register/update/unregister) blocked; reads (isRegistered/getExecutor) keep working', async () => {
    const svc = makeService({ PAUSE_REGISTRY: 'true' });
    const executor = Keypair.fromSecret(DUMMY_EXECUTOR_SEED);

    await expect(svc.registerExecutor(executor, 'ipfs://blocked')).rejects.toThrow(/PAUSE_REGISTRY=1/);
    await expect(svc.updateExecutor(executor, 'https://blocked')).rejects.toThrow(/PAUSE_REGISTRY=1/);
    await expect(svc.unregisterExecutor(executor)).rejects.toThrow(/PAUSE_REGISTRY=1/);

    const callsAfterMutations = lastCallsBackdoor();
    expect(callsAfterMutations.some(c => ['register_executor', 'update_executor', 'unregister_executor'].includes(c.method))).toBe(false);

    await expect(svc.isRegistered(executor.publicKey())).resolves.toBeDefined();
    const svc2 = makeService({ PAUSE_REGISTRY: 'true' });
    const ex2 = Keypair.random();
    await expect(svc2.isRegistered(ex2.publicKey())).resolves.toBe(false);
  });
});
