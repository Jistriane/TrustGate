import { config as loadEnv } from 'dotenv';
import path from 'path';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  contract,
} from '@stellar/stellar-sdk';
import { loadStellarConfig } from '../config/stellar';
import { AccountService } from './accountService';
import { InsufficientBalanceError, MppChargeService } from './mppChargeService';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

const hasLiveNetwork = Boolean(process.env.ADMIN_SECRET);
const describeIfLive = hasLiveNetwork ? describe : describe.skip;

describe('MppChargeService.calculateFee', () => {
  const service = new MppChargeService(
    loadStellarConfig(),
    'CIGNORECONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    'GIGNOREMARKETPLACEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  );

  it('calculates a 0.5% fee', () => {
    expect(service.calculateFee(1000)).toBe(5);
    expect(service.calculateFee(100)).toBe(0.5);
    expect(service.calculateFee(1)).toBe(0.005);
  });
});

describeIfLive('MppChargeService.chargeListingFee (integration)', () => {
  async function fund(publicKey: string, horizonUrl: string): Promise<void> {
    const res = await fetch(`${horizonUrl}/friendbot?addr=${publicKey}`);
    if (!res.ok) {
      throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
    }
  }

  async function submitClassicTx(
    horizon: Horizon.Server,
    source: Keypair,
    networkPassphrase: string,
    operations: ReturnType<typeof Operation.changeTrust | typeof Operation.payment>[],
  ): Promise<void> {
    const account = await horizon.loadAccount(source.publicKey());
    const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase });
    operations.forEach((op) => builder.addOperation(op));
    const tx = builder.setTimeout(60).build();
    tx.sign(source);
    await horizon.submitTransaction(tx);
  }

  it('debits the requester and credits the marketplace wallet', async () => {
    const config = loadStellarConfig();
    const horizon = new Horizon.Server(config.horizonUrl, { allowHttp: true });

    const issuer = Keypair.random();
    const marketplace = Keypair.random();
    const requester = Keypair.random();

    await Promise.all([
      fund(issuer.publicKey(), config.horizonUrl),
      fund(marketplace.publicKey(), config.horizonUrl),
      fund(requester.publicKey(), config.horizonUrl),
    ]);

    const usdc = new Asset('USDC', issuer.publicKey());

    // Wrap the classic asset as a Soroban Asset Contract (one-time, per asset+network).
    const { signTransaction: issuerSign } = contract.basicNodeSigner(
      issuer,
      config.networkPassphrase,
    );
    const createSacTx = await contract.AssembledTransaction.buildWithOp(
      Operation.createStellarAssetContract({ asset: usdc }),
      {
        rpcUrl: config.rpcUrl,
        networkPassphrase: config.networkPassphrase,
        publicKey: issuer.publicKey(),
        allowHttp: true,
        simulate: true,
        signTransaction: issuerSign,
        contractId: 'ignored',
        method: 'create_stellar_asset_contract',
        parseResultXdr: (result: unknown) => result,
      },
    );
    await createSacTx.signAndSend({ force: true });

    // Establish trustlines and give the requester a starting USDC balance.
    await submitClassicTx(horizon, marketplace, config.networkPassphrase, [
      Operation.changeTrust({ asset: usdc }),
    ]);
    await submitClassicTx(horizon, requester, config.networkPassphrase, [
      Operation.changeTrust({ asset: usdc }),
    ]);
    await submitClassicTx(horizon, issuer, config.networkPassphrase, [
      Operation.payment({ destination: requester.publicKey(), asset: usdc, amount: '1000' }),
    ]);

    const usdcSacContractId = usdc.contractId(config.networkPassphrase);
    const chargeService = new MppChargeService(config, usdcSacContractId, marketplace.publicKey());
    const accountService = new AccountService(config);

    const requesterBalanceBefore = await accountService.getUsdcBalance(
      requester.publicKey(),
      issuer.publicKey(),
    );

    const reservePrice = 1000;
    const result = await chargeService.chargeListingFee(requester, reservePrice);

    expect(result.feeAmount).toBe(5);
    expect(result.txHash).toBeTruthy();

    const requesterBalanceAfter = await accountService.getUsdcBalance(
      requester.publicKey(),
      issuer.publicKey(),
    );
    const marketplaceBalance = await accountService.getUsdcBalance(
      marketplace.publicKey(),
      issuer.publicKey(),
    );

    expect(Number(requesterBalanceBefore) - Number(requesterBalanceAfter)).toBeCloseTo(5, 5);
    expect(Number(marketplaceBalance)).toBeCloseTo(5, 5);
  }, 60000);

  it('throws InsufficientBalanceError when the requester has no USDC balance', async () => {
    const config = loadStellarConfig();

    const issuer = Keypair.random();
    const marketplace = Keypair.random();
    const requester = Keypair.random();

    await Promise.all([
      fund(issuer.publicKey(), config.horizonUrl),
      fund(marketplace.publicKey(), config.horizonUrl),
      fund(requester.publicKey(), config.horizonUrl),
    ]);

    const usdc = new Asset('USDC', issuer.publicKey());
    const { signTransaction: issuerSign } = contract.basicNodeSigner(
      issuer,
      config.networkPassphrase,
    );
    const createSacTx = await contract.AssembledTransaction.buildWithOp(
      Operation.createStellarAssetContract({ asset: usdc }),
      {
        rpcUrl: config.rpcUrl,
        networkPassphrase: config.networkPassphrase,
        publicKey: issuer.publicKey(),
        allowHttp: true,
        simulate: true,
        signTransaction: issuerSign,
        contractId: 'ignored',
        method: 'create_stellar_asset_contract',
        parseResultXdr: (result: unknown) => result,
      },
    );
    await createSacTx.signAndSend({ force: true });

    // Requester never establishes a trustline or receives USDC.
    const usdcSacContractId = usdc.contractId(config.networkPassphrase);
    const chargeService = new MppChargeService(config, usdcSacContractId, marketplace.publicKey());

    await expect(chargeService.chargeListingFee(requester, 1000)).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  }, 60000);
});
