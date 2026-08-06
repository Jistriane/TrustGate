import { Keypair } from '@stellar/stellar-sdk';
import { ExecutorInfo, RegistryServiceLike } from './registryService';
import { ChargeResult, MppChargeServiceLike } from './mppChargeService';
import { ConfiscateResult, EscrowServiceLike, ReleaseResult } from './escrowService';
import { calculateListingFeeStroops } from './listingFee';
import { formatUsdcStroopsToDecimal } from '../utils/money';

export function shouldMockExternals(): boolean {
  return process.env.MOCK_EXTERNALS === 'true';
}

export class MockRegistryService implements RegistryServiceLike {
  private executors = new Map<string, ExecutorInfo>();

  async registerExecutor(executor: Keypair, metadataUri: string): Promise<void> {
    const now = Date.now();
    this.executors.set(executor.publicKey(), {
      metadata_uri: metadataUri,
      profile_uri: metadataUri,
      registered_at_ledger: now,
      updated_at_ledger: now,
    });
  }

  async updateExecutor(executor: Keypair, profileUri: string): Promise<void> {
    const existing = this.executors.get(executor.publicKey());
    if (!existing) throw new Error('[MockRegistryService.updateExecutor] not registered');
    this.executors.set(executor.publicKey(), {
      ...existing,
      profile_uri: profileUri,
      updated_at_ledger: Date.now(),
    });
  }

  async unregisterExecutor(executor: Keypair): Promise<void> {
    const existed = this.executors.delete(executor.publicKey());
    if (!existed) throw new Error('[MockRegistryService.unregisterExecutor] not registered');
  }

  async isRegistered(executorPublicKey: string): Promise<boolean> {
    return this.executors.has(executorPublicKey) || true;
  }

  async getExecutor(executorPublicKey: string): Promise<ExecutorInfo> {
    return this.executors.get(executorPublicKey) ?? { metadata_uri: '', profile_uri: '', registered_at_ledger: 0, updated_at_ledger: 0 };
  }
}

export class MockMppChargeService implements MppChargeServiceLike {
  calculateFeeStroops(reservePriceStroops: bigint): bigint {
    return calculateListingFeeStroops(reservePriceStroops);
  }

  async chargeListingFee(_requester: Keypair, reservePriceStroops: bigint): Promise<ChargeResult> {
    const feeStroops = this.calculateFeeStroops(reservePriceStroops);
    return {
      feeAmount: formatUsdcStroopsToDecimal(feeStroops),
      feeStroops: feeStroops.toString(),
      txHash: 'mock-tx',
    };
  }
}

export class MockEscrowService implements EscrowServiceLike {
  async createEscrow(_executorPublicKey: string, taskId: string, _collateralAmount: number): Promise<string> {
    return `mock-escrow:${taskId}`;
  }

  async releaseMilestone(escrowId: string): Promise<ReleaseResult> {
    return {
      success: true,
      transactionHash: `mock-release:${escrowId}`,
      amountReleased: 0,
      receiver: 'mock-receiver',
    };
  }

  async confiscate(escrowId: string, _collateralAmount: number, requesterSharePct: number = 0.7): Promise<ConfiscateResult> {
    const requesterShare = 0;
    const marketplaceShare = 0;
    return {
      success: true,
      disputeId: `mock-dispute:${escrowId}`,
      status: 'mocked',
      requesterShare: Math.round(requesterShare * requesterSharePct * 100) / 100,
      marketplaceShare: Math.round(marketplaceShare * 100) / 100,
    };
  }
}

