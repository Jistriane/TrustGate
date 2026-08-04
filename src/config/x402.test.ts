import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
process.env.MARKETPLACE_WALLET = process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
process.env.REGISTRY_CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';

const hasRealOzApiKey = Boolean(process.env.OZ_API_KEY) && process.env.OZ_API_KEY !== 'fake-oz-key';
const describeIfRealFacilitator = hasRealOzApiKey ? describe : describe.skip;

describe('GET /executor/tasks/:taskId/result', () => {
  it('is not mounted when OZ_API_KEY is unset', async () => {
    const previous = process.env.OZ_API_KEY;
    delete process.env.OZ_API_KEY;

    const app = createApp();
    const response = await request(app).get('/executor/tasks/task-1/result');
    expect(response.status).toBe(404);

    if (previous !== undefined) process.env.OZ_API_KEY = previous;
  });

  it('returns 503 (not a bare 500) when the configured facilitator is unreachable', async () => {
    const previous = process.env.OZ_API_KEY;
    process.env.OZ_API_KEY = 'fake-oz-key';

    const app = createApp();
    const response = await request(app).get('/executor/tasks/task-1/result');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('payment gate unavailable');

    if (previous === undefined) delete process.env.OZ_API_KEY;
    else process.env.OZ_API_KEY = previous;
  }, 15000);

  describeIfRealFacilitator('with a live OZ Channels facilitator', () => {
    it('returns 402 when no payment header is present', async () => {
      const app = createApp();
      const response = await request(app).get('/executor/tasks/task-1/result');
      expect(response.status).toBe(402);
    }, 15000);
  });
});
