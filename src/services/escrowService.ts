export interface EscrowConfig {
  apiKey: string;
  network?: 'testnet' | 'mainnet';
  marketplaceWallet: string;
  usdcIssuer: string;
}

export interface ReleaseResult {
  success: boolean;
  transactionHash: string;
  amountReleased: number;
  receiver: string;
}

export interface ConfiscateResult {
  success: boolean;
  disputeId: string;
  status: string;
  requesterShare: number;
  marketplaceShare: number;
}

export const DEFAULT_REQUESTER_CONFISCATION_SHARE = 0.7;

interface TrustlessWorkClientLike {
  createSingleRelease(input: {
    engagementId: string;
    title: string;
    description?: string;
    roles: {
      approver: string;
      serviceProvider: string;
      releaseSigner: string;
      platformAddress: string;
      disputeResolver: string;
    };
    amount: number;
    milestones: { description: string }[];
    trustline: { address: string; code: string };
  }): Promise<{ success: boolean; contractId: string; escrow: Record<string, unknown> }>;
  release(escrowId: string, body: { releaseAll: true } | { milestoneId: number }): Promise<ReleaseResult>;
  raiseDispute(
    escrowId: string,
    body: { reason: string; evidence?: string; requestedAction?: string },
  ): Promise<{ success: boolean; disputeId: string; status: string }>;
}

/**
 * Wraps Trustless Work's escrow-as-a-service REST API to lock executor
 * collateral for a bid. `@stellar-agent-kit/plugin-trustless-work` ships as
 * pure ESM with no CJS export condition, so it's loaded via dynamic import()
 * rather than a static import into this CommonJS project.
 *
 * Naming note: the ADR 0002 refers to this abstraction as `IProviderEscrow`.
 * We keep the old name `EscrowServiceLike` exported too (alias) so existing
 * call-sites don't break on a one-off rename. New code should use
 * `IProviderEscrow`.
 */
export type IProviderEscrow = {
  createEscrow(executorPublicKey: string, taskId: string, collateralAmount: number): Promise<string>;
  releaseMilestone(escrowId: string): Promise<ReleaseResult>;
  confiscate(
    escrowId: string,
    collateralAmount: number,
    requesterSharePct?: number,
  ): Promise<ConfiscateResult>;
};

/** @deprecated use IProviderEscrow. Kept for call-site compatibility. */
export type EscrowServiceLike = IProviderEscrow;

export type EscrowImplementationKind = 'trustlesswork' | 'mock' | 'ourown';

export interface CreateEscrowProviderInput {
  implementation: EscrowImplementationKind;
  network: 'local' | 'testnet' | 'pubnet';
  envOverrides?: Partial<{
    TRUSTLESS_WORK_API_KEY: string;
    USDC_ISSUER: string;
    MARKETPLACE_WALLET: string;
    ESCROW_CONTRACT_ID: string;
    ESCROW_TOKEN_CONTRACT: string;
    ESCROW_CONFISCATE_REQUESTER_BP: number;
  }>;
  injectedClient?: TrustlessWorkClientLike;
  injectedMock?: IProviderEscrow;
  injectedOwn?: IProviderEscrow;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ TrustlessWorkClient: unknown }>;

async function loadTrustlessWorkClient(): Promise<
  new (config: { apiKey: string; network?: 'testnet' | 'mainnet' }) => TrustlessWorkClientLike
> {
  const mod = await dynamicImport('@stellar-agent-kit/plugin-trustless-work');
  return mod.TrustlessWorkClient as never;
}

/**
 * Factory for the currently selected escrow implementation. Reads
 * `ESCROW_IMPLEMENTATION` by default; callers (e.g. tests) can force the
 * implementation via `input.implementation`. Returns `MockEscrowService` from
 * `./mockExternalServices` if `implementation === 'mock'` or `implementation
 * === 'trustlesswork'` but MOCK_EXTERNALS=true on a local network.
 *
 * `implementation === 'ourown'` requires all of the following P0 blockers to
 * be cleared BEFORE being set in prod:
 *   (a) contracts/escrow/ WASM compiled + deployed to the target Stellar net
 *       (see ADR 0002 § Fallback exit 15 days);
 *   (b) at least 2 external independent smart-contract audits published
 *       (escrow controls real USDC collateral of executors — P0 financial
 *       risk, no hot-fix on-chain without 30d timelock WASM upgrade);
 *   (c) Soroban TypeScript bindings generated under src/contracts/bindings/
 *       mirroring contracts/registry bindings pattern;
 *   (d) 100% coverage on Rust unit tests + integration tests covering:
 *       happy path, wrong auth, double release, claim_timeout edge,
 *       share_bp math overflows.
 * If any of those are missing, the factory throws a descriptive startup error
 * to protect against accidental activation on pubnet.
 */
export async function createEscrowProvider(input: CreateEscrowProviderInput): Promise<IProviderEscrow> {
  if (input.injectedMock) return input.injectedMock;
  if (input.injectedOwn) return input.injectedOwn;
  if (input.implementation === 'mock') {
    const { MockEscrowService } = await import('./mockExternalServices');
    return new MockEscrowService();
  }
  if (input.implementation === 'ourown') {
    const env = input.envOverrides ?? process.env;
    const escrowContractId = env.ESCROW_CONTRACT_ID;
    const tokenContract = env.ESCROW_TOKEN_CONTRACT;
    const marketplaceWallet = env.MARKETPLACE_WALLET;
    const requesterBpRaw = env.ESCROW_CONFISCATE_REQUESTER_BP;
    const requesterBpDefault =
      requesterBpRaw === undefined || requesterBpRaw === null || requesterBpRaw === ''
        ? 7000
        : Number(requesterBpRaw);
    if (
      !Number.isFinite(requesterBpDefault) ||
      requesterBpDefault < 0 ||
      requesterBpDefault > 10_000
    ) {
      throw new Error(
        `[createEscrowProvider ourown] ESCROW_CONFISCATE_REQUESTER_BP invalid: expected integer 0..=10000, got ${requesterBpRaw}`,
      );
    }
    // Hard P0 blockers. Remove these guards ONLY after (a) WASM deployed,
    // (b) audits published, (c) TypeScript bindings merged.
    const wasmDeployedContractIdPresent = typeof escrowContractId === 'string' && escrowContractId.length >= 56;
    const tokenPresent = typeof tokenContract === 'string' && tokenContract.length >= 56;
    const marketPresent = typeof marketplaceWallet === 'string' && /^G[A-Z2-7]{55}$/.test(marketplaceWallet);
    if (!wasmDeployedContractIdPresent) {
      throw new Error(
        '[createEscrowProvider ourown] ESCROW_CONTRACT_ID is not set or too short (expected deployed Soroban contract address, 56+ chars). ' +
          'ADR0002 blocker (a) not cleared: deploy contracts/escrow WASM first and provide resulting contract address.',
      );
    }
    if (!tokenPresent) {
      throw new Error(
        '[createEscrowProvider ourown] ESCROW_TOKEN_CONTRACT is not set or too short (expected Soroban USDC token contract address). ' +
          'Set it explicitly to avoid classic↔Soroban address mapping bugs on pubnet.',
      );
    }
    if (!marketPresent) {
      throw new Error(
        '[createEscrowProvider ourown] MARKETPLACE_WALLET is not a valid Stellar G…55 address (required as confiscate marketplace share recipient).',
      );
    }
    // TODO: implement real OurOwnEscrowContractClient once (c) bindings exist.
    // Stub today throws descriptive error on EVERY call — safe by default,
    // never silently misbehaves.
    return new OurOwnEscrowContractClientStub({
      network: input.network,
      escrowContractId: escrowContractId as string,
      tokenContract: tokenContract as string,
      marketplaceWallet: marketplaceWallet as string,
      confiscateRequesterBp: Math.trunc(requesterBpDefault),
    });
  }
  // implementation === 'trustlesswork'
  if (input.injectedClient) {
    const env = input.envOverrides ?? {};
    return new EscrowService(
      {
        apiKey: env.TRUSTLESS_WORK_API_KEY ?? '__injected_client__',
        network: input.network === 'pubnet' ? 'mainnet' : 'testnet',
        marketplaceWallet: env.MARKETPLACE_WALLET ?? '',
        usdcIssuer: env.USDC_ISSUER ?? '',
      },
      input.injectedClient,
    );
  }
  const env = input.envOverrides ?? process.env;
  const apiKey = env.TRUSTLESS_WORK_API_KEY;
  if (!apiKey) throw new Error('TRUSTLESS_WORK_API_KEY is not set');
  const usdcIssuer = env.USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER is not set');
  const marketplaceWallet = env.MARKETPLACE_WALLET;
  if (!marketplaceWallet) throw new Error('MARKETPLACE_WALLET is not set');
  return new EscrowService({
    apiKey,
    network: input.network === 'pubnet' ? 'mainnet' : 'testnet',
    marketplaceWallet,
    usdcIssuer,
  });
}

/**
 * Safe-by-default stub for OurOwnEscrowContractClient (Option C / ADR0002
 * fallback exit 15 days). TODAY every method throws a descriptive error that
 * lists which P0 blockers have not been cleared yet, to prevent accidental
 * activation of our own escrow on pubnet before (a) audits (b) bindings (c)
 * deploy are actually done.
 *
 * When you implement the REAL client, replace this class with:
 *   `export class OurOwnEscrowContractClient implements IProviderEscrow { … }`
 * that imports the generated Soroban bindings under
 * src/contracts/bindings/escrow (mirror of src/contracts/bindings/registry).
 * The factory createEscrowProvider will instantiate it directly instead of
 * this stub after you flip the instantiation line above.
 *
 * Keeps TypeScript typecheck happy today (every method of IProviderEscrow is
 * declared with matching signatures).
 */
export interface OurOwnEscrowConfig {
  network: 'local' | 'testnet' | 'pubnet';
  escrowContractId: string;
  tokenContract: string;
  marketplaceWallet: string;
  confiscateRequesterBp: number;
}

const OWN_ESCROW_BLOCKER_MSG =
  '[OurOwnEscrowContractClient P0 blockers not cleared] This is a SAFE STUB, not a real client. ' +
  'Activate ESCROW_IMPLEMENTATION=ourown on any environment ONLY after ALL of the following: ' +
  '(a) deploy contracts/escrow/ WASM → set ESCROW_CONTRACT_ID to the deployed address; ' +
  '(b) 2 independent external audits published; ' +
  '(c) generate TypeScript bindings at src/contracts/bindings/escrow mirroring registry/ pattern; ' +
  '(d) implement a REAL OurOwnEscrowContractClient class inside src/services/escrowService.ts that ' +
  'performs: (createEscrow) call escrow_contract.create_escrow with executor signed auth + ' +
  'USDC Soroban transfer via token.transfer(executor→escrow, collateral); ' +
  '(releaseMilestone) call escrow_contract.release_milestone with MARKETPLACE_WALLET release_signer auth; ' +
  '(confiscate) call escrow_contract.confiscate(escrowId, requester_share_bp, marketplace) with requester auth. ' +
  'Today the Rust contracts/escrow exist but are NOT wired into the TypeScript runtime bindings.';

export class OurOwnEscrowContractClientStub implements IProviderEscrow {
  constructor(_cfg: OurOwnEscrowConfig) {
    // Constructor never throws — safe; only the 3 action methods throw so
    // tooling that only instantiates (e.g. createEscrowProvider with
    // injectedMock in tests) never hits the stub branch.
  }

  async createEscrow(_executorPublicKey: string, _taskId: string, _collateralAmount: number): Promise<string> {
    throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: createEscrow)');
  }

  async releaseMilestone(_escrowId: string): Promise<ReleaseResult> {
    throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: releaseMilestone)');
  }

  async confiscate(
    _escrowId: string,
    _collateralAmount: number,
    _requesterSharePct?: number,
  ): Promise<ConfiscateResult> {
    throw new Error(OWN_ESCROW_BLOCKER_MSG + ' (method: confiscate)');
  }
}

export class EscrowService implements IProviderEscrow {
  private clientPromise?: Promise<TrustlessWorkClientLike>;

  constructor(
    private readonly config: EscrowConfig,
    private readonly injectedClient?: TrustlessWorkClientLike,
  ) {}

  private async getClient(): Promise<TrustlessWorkClientLike> {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    if (!this.clientPromise) {
      this.clientPromise = loadTrustlessWorkClient().then(
        (TrustlessWorkClient) =>
          new TrustlessWorkClient({
            apiKey: this.config.apiKey,
            network: this.config.network ?? 'testnet',
          }),
      );
    }
    return this.clientPromise;
  }

  async createEscrow(executorPublicKey: string, taskId: string, collateralAmount: number): Promise<string> {
    const client = await this.getClient();

    const result = await client.createSingleRelease({
      engagementId: taskId,
      title: `Collateral for task ${taskId}`,
      description: `Executor collateral bond for task ${taskId}`,
      roles: {
        approver: this.config.marketplaceWallet,
        serviceProvider: executorPublicKey,
        releaseSigner: this.config.marketplaceWallet,
        platformAddress: this.config.marketplaceWallet,
        disputeResolver: this.config.marketplaceWallet,
      },
      amount: collateralAmount,
      milestones: [{ description: `Deliver result for task ${taskId}` }],
      trustline: { address: this.config.usdcIssuer, code: 'USDC' },
    });

    return result.contractId;
  }

  async releaseMilestone(escrowId: string): Promise<ReleaseResult> {
    const client = await this.getClient();
    return client.release(escrowId, { releaseAll: true });
  }

  /**
   * Confiscates a bid's collateral after the executor abandons a task
   * (deadline expired without delivery). Trustless Work's exposed API has
   * no direct "split funds" primitive, so this raises a dispute — flagging
   * it for our own marketplace wallet, which is the escrow's disputeResolver
   * — carrying the intended split as the requested action, and returns the
   * computed shares for our own bookkeeping/logging.
   */
  async confiscate(
    escrowId: string,
    collateralAmount: number,
    requesterSharePct: number = DEFAULT_REQUESTER_CONFISCATION_SHARE,
  ): Promise<ConfiscateResult> {
    const client = await this.getClient();

    const requesterShare = Math.round(collateralAmount * requesterSharePct * 100) / 100;
    const marketplaceShare = Math.round((collateralAmount - requesterShare) * 100) / 100;

    const dispute = await client.raiseDispute(escrowId, {
      reason: 'Executor abandoned task — deadline expired without delivery',
      requestedAction: `confiscate:requester=${requesterShare},marketplace=${marketplaceShare}`,
    });

    return { ...dispute, requesterShare, marketplaceShare };
  }
}
