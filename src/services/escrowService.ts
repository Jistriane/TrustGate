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

export interface CreateEscrowProviderInput {
  implementation: 'trustlesswork' | 'mock';
  network: 'local' | 'testnet' | 'pubnet';
  envOverrides?: Partial<{
    TRUSTLESS_WORK_API_KEY: string;
    USDC_ISSUER: string;
    MARKETPLACE_WALLET: string;
  }>;
  injectedClient?: TrustlessWorkClientLike;
  injectedMock?: IProviderEscrow;
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
 */
export async function createEscrowProvider(input: CreateEscrowProviderInput): Promise<IProviderEscrow> {
  if (input.injectedMock) return input.injectedMock;
  if (input.implementation === 'mock') {
    const { MockEscrowService } = await import('./mockExternalServices');
    return new MockEscrowService();
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
