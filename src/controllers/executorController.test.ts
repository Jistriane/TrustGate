import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';
import { loadStellarConfig } from '../config/stellar';
import { RegistryService } from '../services/registryService';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

const hasLiveRegistry = Boolean(process.env.REGISTRY_CONTRACT_ID);
const describeIfLive = hasLiveRegistry ? describe : describe.skip;

describeIfLive('POST /executors/register (integration)', () => {
  beforeAll(() => {
    process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
    process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';
  });

  it('registers a new executor and the contract reflects it', async () => {
    const config = loadStellarConfig();
    const executor = Keypair.random();

    const fundRes = await fetch(`${config.horizonUrl}/friendbot?addr=${executor.publicKey()}`);
    expect(fundRes.ok).toBe(true);

    const app = createApp();
    const metadataUri = 'https://example.com/executor.json';

    const response = await request(app)
      .post('/executors/register')
      .send({ secret: executor.secret(), metadataUri });

    expect(response.status).toBe(201);
    expect(response.body.publicKey).toBe(executor.publicKey());

    const registryService = new RegistryService(
      config,
      process.env.REGISTRY_CONTRACT_ID as string,
    );

    const isRegistered = await registryService.isRegistered(executor.publicKey());
    expect(isRegistered).toBe(true);

    const info = await registryService.getExecutor(executor.publicKey());
    expect(info.metadata_uri).toBe(metadataUri);
  }, 30000);

  it('rejects a request missing required fields', async () => {
    const app = createApp();
    const response = await request(app).post('/executors/register').send({});
    expect(response.status).toBe(400);
  });
});
