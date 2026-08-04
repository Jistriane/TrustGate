import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { RequestHandler } from 'express';
import { createApp } from './app';

/**
 * On testnet/pubnet, POST /tasks is gated behind the real MPP Charge
 * protocol (src/config/mppCharge.ts) instead of the local-network direct
 * debit flow. These tests inject a fake gate factory (AppOverrides) so the
 * wiring — dynamic per-request fee amount, 402 short-circuit, fall-through
 * to TaskController.createPaid with no `secret` field — can be verified
 * without a live testnet, an OZ-style facilitator, or real signed credentials.
 */
describe('POST /tasks on testnet (MPP Charge gate)', () => {
  const previousNetwork = process.env.NETWORK;

  beforeAll(() => {
    process.env.NETWORK = 'testnet';
    process.env.REGISTRY_CONTRACT_ID =
      process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
    process.env.MARKETPLACE_WALLET =
      process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
    process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';
  });

  afterAll(() => {
    process.env.NETWORK = previousNetwork;
  });

  function futureDate(daysFromNow: number): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  it('rejects a POST /tasks with no MPP_SECRET_KEY or override configured', () => {
    delete process.env.MPP_SECRET_KEY;
    expect(() => createApp()).toThrow(/MPP_SECRET_KEY/);
  });

  it('computes the fee from the request body and returns the challenge on 402', async () => {
    const seenAmounts: string[] = [];
    const fakeGate: RequestHandler = (_req, res) => {
      res.status(402).json({ error: 'payment required', challenge: 'fake-challenge' });
    };

    const app = createApp({
      listingFeeGateFactory: async (amount) => {
        seenAmounts.push(amount);
        return fakeGate;
      },
    });

    const requester = Keypair.random();
    const response = await request(app)
      .post('/tasks')
      .send({
        requester: requester.publicKey(),
        reservePrice: 1000,
        description: 'Do something useful',
        deadline: futureDate(1),
      });

    expect(response.status).toBe(402);
    expect(response.body.challenge).toBe('fake-challenge');
    // 0.5% of 1000 = 5
    expect(seenAmounts).toEqual(['5']);
  });

  it('creates the task with no secret once the gate calls next()', async () => {
    const app = createApp({
      listingFeeGateFactory: async () => (_req, _res, next) => next(),
    });

    const requester = Keypair.random();
    const response = await request(app)
      .post('/tasks')
      .send({
        requester: requester.publicKey(),
        reservePrice: 200,
        description: 'Summarize this document',
        deadline: futureDate(1),
      });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('OPEN');
    expect(response.body.requester).toBe(requester.publicKey());
    expect(response.body).not.toHaveProperty('secret');
  });

  it('rejects an invalid payload before the gate is invoked', async () => {
    const gate = jest.fn();
    const app = createApp({ listingFeeGateFactory: async () => gate });

    const response = await request(app).post('/tasks').send({});

    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });
});
