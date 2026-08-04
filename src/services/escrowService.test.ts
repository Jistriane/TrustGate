import { Keypair } from '@stellar/stellar-sdk';
import { EscrowService } from './escrowService';

const marketplaceWallet = 'GBMARKETPLACE00000000000000000000000000000000000000000';
const usdcIssuer = 'GBUSDCISSUER0000000000000000000000000000000000000000000';

function makeFakeClient(overrides: Partial<Record<'createSingleRelease' | 'release' | 'raiseDispute', jest.Mock>> = {}) {
  return {
    createSingleRelease: jest.fn(),
    release: jest.fn(),
    raiseDispute: jest.fn(),
    ...overrides,
  };
}

describe('EscrowService.createEscrow', () => {
  it('creates a single-release escrow and returns its contract id', async () => {
    const executor = Keypair.random().publicKey();
    const createSingleRelease = jest.fn().mockResolvedValue({
      success: true,
      contractId: 'CESCROWCONTRACTID000000000000000000000000000000000000',
      escrow: {},
    });
    const fakeClient = makeFakeClient({ createSingleRelease });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    const escrowId = await service.createEscrow(executor, 'task-123', 50);

    expect(escrowId).toBe('CESCROWCONTRACTID000000000000000000000000000000000000');
    expect(createSingleRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        engagementId: 'task-123',
        amount: 50,
        roles: expect.objectContaining({
          serviceProvider: executor,
          approver: marketplaceWallet,
          releaseSigner: marketplaceWallet,
          platformAddress: marketplaceWallet,
          disputeResolver: marketplaceWallet,
        }),
        trustline: { address: usdcIssuer, code: 'USDC' },
      }),
    );
  });

  it('propagates errors from the Trustless Work client', async () => {
    const executor = Keypair.random().publicKey();
    const createSingleRelease = jest.fn().mockRejectedValue(new Error('API unavailable'));
    const fakeClient = makeFakeClient({ createSingleRelease });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    await expect(service.createEscrow(executor, 'task-123', 50)).rejects.toThrow('API unavailable');
  });
});

describe('EscrowService.releaseMilestone', () => {
  it('releases the full escrow and returns the release result', async () => {
    const release = jest.fn().mockResolvedValue({
      success: true,
      transactionHash: 'txhash123',
      amountReleased: 50,
      receiver: 'GBEXECUTOR000000000000000000000000000000000000000000000',
    });
    const fakeClient = makeFakeClient({ release });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    const result = await service.releaseMilestone('CESCROWCONTRACTID000000000000000000000000000000000000');

    expect(release).toHaveBeenCalledWith('CESCROWCONTRACTID000000000000000000000000000000000000', {
      releaseAll: true,
    });
    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('txhash123');
  });

  it('propagates errors from the Trustless Work client', async () => {
    const release = jest.fn().mockRejectedValue(new Error('release failed'));
    const fakeClient = makeFakeClient({ release });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    await expect(service.releaseMilestone('escrow-1')).rejects.toThrow('release failed');
  });
});

describe('EscrowService.confiscate', () => {
  it('raises a dispute and computes the requester/marketplace split', async () => {
    const raiseDispute = jest.fn().mockResolvedValue({
      success: true,
      disputeId: 'dispute-1',
      status: 'open',
    });
    const fakeClient = makeFakeClient({ raiseDispute });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    const result = await service.confiscate('escrow-1', 100);

    expect(raiseDispute).toHaveBeenCalledWith(
      'escrow-1',
      expect.objectContaining({
        requestedAction: expect.stringContaining('confiscate:requester=70,marketplace=30'),
      }),
    );
    expect(result.disputeId).toBe('dispute-1');
    expect(result.requesterShare).toBe(70);
    expect(result.marketplaceShare).toBe(30);
  });

  it('supports a custom requester share percentage', async () => {
    const raiseDispute = jest.fn().mockResolvedValue({
      success: true,
      disputeId: 'dispute-2',
      status: 'open',
    });
    const fakeClient = makeFakeClient({ raiseDispute });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    const result = await service.confiscate('escrow-1', 100, 0.5);

    expect(result.requesterShare).toBe(50);
    expect(result.marketplaceShare).toBe(50);
  });

  it('propagates errors from the Trustless Work client', async () => {
    const raiseDispute = jest.fn().mockRejectedValue(new Error('dispute failed'));
    const fakeClient = makeFakeClient({ raiseDispute });

    const service = new EscrowService(
      { apiKey: 'test-key', marketplaceWallet, usdcIssuer },
      fakeClient,
    );

    await expect(service.confiscate('escrow-1', 100)).rejects.toThrow('dispute failed');
  });
});
