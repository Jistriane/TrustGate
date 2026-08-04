import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  contract,
} from '@stellar/stellar-sdk';
import { createApp } from '../app';
import { loadStellarConfig } from '../config/stellar';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

const hasLiveNetwork = Boolean(process.env.ADMIN_SECRET);
const describeIfLive = hasLiveNetwork ? describe : describe.skip;

process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';

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

async function wrapAsSac(
  usdc: Asset,
  issuer: Keypair,
  config: ReturnType<typeof loadStellarConfig>,
): Promise<void> {
  const { signTransaction } = contract.basicNodeSigner(issuer, config.networkPassphrase);
  const createSacTx = await contract.AssembledTransaction.buildWithOp(
    Operation.createStellarAssetContract({ asset: usdc }),
    {
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      publicKey: issuer.publicKey(),
      allowHttp: true,
      simulate: true,
      signTransaction,
      contractId: 'ignored',
      method: 'create_stellar_asset_contract',
      parseResultXdr: (result: unknown) => result,
    },
  );
  await createSacTx.signAndSend({ force: true });
}

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

describeIfLive('POST /tasks (integration)', () => {
  it('charges the listing fee and saves the task', async () => {
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
    await wrapAsSac(usdc, issuer, config);

    await submitClassicTx(horizon, marketplace, config.networkPassphrase, [
      Operation.changeTrust({ asset: usdc }),
    ]);
    await submitClassicTx(horizon, requester, config.networkPassphrase, [
      Operation.changeTrust({ asset: usdc }),
    ]);
    await submitClassicTx(horizon, issuer, config.networkPassphrase, [
      Operation.payment({ destination: requester.publicKey(), asset: usdc, amount: '1000' }),
    ]);

    process.env.USDC_ISSUER = issuer.publicKey();
    process.env.MARKETPLACE_WALLET = marketplace.publicKey();

    const app = createApp();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    const response = await request(app)
      .post('/tasks')
      .send({
        requester: requester.publicKey(),
        secret: requester.secret(),
        reservePrice: 1000,
        description: 'Do something useful',
        deadline: futureDate(1),
      });

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\[Task Feed\] tick #\d+/));
    logSpy.mockRestore();

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('OPEN');
    expect(response.body.requester).toBe(requester.publicKey());
    expect(response.body.id).toBeTruthy();
  }, 60000);

  it('returns 402 when the requester has insufficient USDC balance', async () => {
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
    await wrapAsSac(usdc, issuer, config);

    // Requester never establishes a trustline or receives USDC.
    process.env.USDC_ISSUER = issuer.publicKey();
    process.env.MARKETPLACE_WALLET = marketplace.publicKey();

    const app = createApp();

    const response = await request(app)
      .post('/tasks')
      .send({
        requester: requester.publicKey(),
        secret: requester.secret(),
        reservePrice: 1000,
        description: 'Do something useful',
        deadline: futureDate(1),
      });

    expect(response.status).toBe(402);
  }, 60000);

  it('rejects a payload with mismatched secret/requester', async () => {
    process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
    process.env.MARKETPLACE_WALLET = process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
    const app = createApp();
    const other = Keypair.random();
    const requester = Keypair.random();

    const response = await request(app)
      .post('/tasks')
      .send({
        requester: requester.publicKey(),
        secret: other.secret(),
        reservePrice: 100,
        description: 'x',
        deadline: futureDate(1),
      });

    expect(response.status).toBe(400);
  });

  it('rejects an invalid payload', async () => {
    process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
    process.env.MARKETPLACE_WALLET = process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
    const app = createApp();
    const response = await request(app).post('/tasks').send({});
    expect(response.status).toBe(400);
  });
});
