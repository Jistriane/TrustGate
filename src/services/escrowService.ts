import { Keypair } from '@stellar/stellar-sdk';

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

// TypeScript downlevels `import()` to `require()` under `module: "commonjs"`,
// which breaks against a package with no "require" export condition. The
// indirect call via `Function` hides the import from that static rewrite so
// Node resolves it as a genuine dynamic ESM import at runtime.
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
 * Wraps Trustless Work's escrow-as-a-service REST API to lock executor
 * collateral for a bid. `@stellar-agent-kit/plugin-trustless-work` ships as
 * pure ESM with no CJS export condition, so it's loaded via dynamic import()
 * rather than a static import into this CommonJS project.
 */
export interface EscrowServiceLike {
  createEscrow(executor: Keypair, taskId: string, collateralAmount: number): Promise<string>;
  releaseMilestone(escrowId: string): Promise<ReleaseResult>;
  confiscate(
    escrowId: string,
    collateralAmount: number,
    requesterSharePct?: number,
  ): Promise<ConfiscateResult>;
}

export class EscrowService implements EscrowServiceLike {
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

  async createEscrow(executor: Keypair, taskId: string, collateralAmount: number): Promise<string> {
    const client = await this.getClient();

    const result = await client.createSingleRelease({
      engagementId: taskId,
      title: `Collateral for task ${taskId}`,
      description: `Executor collateral bond for task ${taskId}`,
      roles: {
        approver: this.config.marketplaceWallet,
        serviceProvider: executor.publicKey(),
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
