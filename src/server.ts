import 'dotenv/config';
import { createApp } from './app';
import { loadStellarConfig } from './config/stellar';
import { generateKeypair, loadKeypairFromEnv } from './utils/keypair';
import { AccountService } from './services/accountService';
import { TaskFeedService } from './services/taskFeedService';
import { FeedListenerService } from './services/feedListenerService';
import { TimeoutService } from './services/timeoutService';
import path from 'path';
import { getDbPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { PgOutboxRepository } from './repositories/outboxRepository';
import { getRedisClient } from './config/redis';
import { WorkerService } from './services/workerService';
import { PgEventConsumptionRepository } from './repositories/eventConsumptionRepository';
import { PgTaskRepository } from './repositories/taskRepository';
import { PgBidRepository } from './repositories/bidRepository';
import { EscrowService } from './services/escrowService';
import { OutboxService } from './services/outboxService';
import { WebhookService } from './services/webhookService';
import { isTransientNetworkError, withRetry } from './utils/retry';

async function fundOnFriendbot(horizonUrl: string, publicKey: string): Promise<void> {
  const res = await fetch(`${horizonUrl}/friendbot?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
  }
}

async function checkStellarConnectivity(): Promise<void> {
  const config = loadStellarConfig();
  console.log(`Connecting to Stellar (${config.network}) via ${config.horizonUrl}`);

  const admin = process.env.ADMIN_SECRET
    ? loadKeypairFromEnv('ADMIN_SECRET')
    : generateKeypair();

  if (!process.env.ADMIN_SECRET && config.network === 'local') {
    console.log(`No ADMIN_SECRET set, funding throwaway admin ${admin.publicKey()} via friendbot`);
    await withRetry(() => fundOnFriendbot(config.horizonUrl, admin.publicKey()), {
      retries: 8,
      baseDelayMs: 500,
      shouldRetry: (err) => isTransientNetworkError(err) || String(err).includes('Friendbot funding failed: 5'),
    });
  }

  const accountService = new AccountService(config);
  const xlmBalance = await accountService.getXlmBalance(admin.publicKey());

  console.log(`Admin account: ${admin.publicKey()}`);
  console.log(`XLM balance: ${xlmBalance}`);
}

async function main(): Promise<void> {
  await checkStellarConnectivity();

  if (process.env.DATABASE_URL) {
    const pool = getDbPool();
    await runMigrations(pool, path.resolve(__dirname, '../migrations'));
  }

  const port = Number(process.env.PORT) || 3000;
  const app = createApp();

  const taskFeedService = app.get('taskFeedService') as TaskFeedService;
  new FeedListenerService(taskFeedService);

  const timeoutService = app.get('timeoutService') as TimeoutService;
  timeoutService.schedule();

  if (process.env.DATABASE_URL && process.env.REDIS_URL && process.env.WORKER_ENABLED !== 'false') {
    const pool = getDbPool();
    const outbox = new PgOutboxRepository(pool);
    const consumptions = new PgEventConsumptionRepository(pool);
    const taskRepository = new PgTaskRepository(pool);
    const bidRepository = new PgBidRepository(pool);

    const config = loadStellarConfig();
    const trustlessWorkApiKey = process.env.TRUSTLESS_WORK_API_KEY;
    if (!trustlessWorkApiKey) {
      throw new Error('TRUSTLESS_WORK_API_KEY is not set');
    }
    const usdcIssuer = process.env.USDC_ISSUER;
    if (!usdcIssuer) {
      throw new Error('USDC_ISSUER is not set');
    }
    const marketplaceWallet = process.env.MARKETPLACE_WALLET;
    if (!marketplaceWallet) {
      throw new Error('MARKETPLACE_WALLET is not set');
    }
    const escrowService = new EscrowService({
      apiKey: trustlessWorkApiKey,
      network: config.network === 'pubnet' ? 'mainnet' : 'testnet',
      marketplaceWallet,
      usdcIssuer,
    });

    const outboxService = new OutboxService(outbox);
    const webhookService = new WebhookService({
      timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 5000),
    });
    const redis = await getRedisClient();
    const worker = new WorkerService(
      outbox,
      consumptions,
      taskRepository,
      bidRepository,
      escrowService,
      outboxService,
      webhookService,
      redis,
      {
        streamKey: process.env.OUTBOX_STREAM_KEY ?? 'tg:events',
        publishIntervalMs: Number(process.env.WORKER_POLL_MS ?? 2000),
        consumerGroup: process.env.OUTBOX_CONSUMER_GROUP ?? 'tg-workers',
        consumerName: process.env.OUTBOX_CONSUMER_NAME ?? `worker-${process.pid}`,
        maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS ?? 10),
        webhookUrl: process.env.RESULT_PUBLISHED_WEBHOOK_URL,
      },
    );
    await worker.start();
  }

  app.listen(port, () => {
    console.log(`TrustGate server listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
