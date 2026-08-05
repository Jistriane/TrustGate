import 'dotenv/config';
import { createApp } from './app';
import { loadStellarConfig } from './config/stellar';
import { generateKeypair, loadKeypairFromEnv } from './utils/keypair';
import { AccountService } from './services/accountService';
import { TaskFeedService } from './services/taskFeedService';
import { FeedListenerService } from './services/feedListenerService';
import { TimeoutService } from './services/timeoutService';
import path from 'path';
import { createHash } from 'crypto';
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
import { MockEscrowService, shouldMockExternals } from './services/mockExternalServices';
import { logger } from './config/logger';
import { loadSafetyFeatures } from './config/safetyFeatures';

async function fundOnFriendbot(horizonUrl: string, publicKey: string): Promise<void> {
  const res = await fetch(`${horizonUrl}/friendbot?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
  }
}

async function checkStellarConnectivity(): Promise<void> {
  const config = loadStellarConfig();
  logger.info({ network: config.network, horizonUrl: config.horizonUrl }, 'Connecting to Stellar');

  const admin = process.env.ADMIN_SECRET
    ? loadKeypairFromEnv('ADMIN_SECRET')
    : generateKeypair();
  const adminPublicKey = admin.publicKey();

  if (config.network === 'local') {
    try {
      const label = process.env.ADMIN_SECRET ? 'ADMIN_SECRET' : 'throwaway admin';
      logger.info({ label, publicKey: adminPublicKey }, 'Funding admin via friendbot');
      await withRetry(() => fundOnFriendbot(config.horizonUrl, adminPublicKey), {
        retries: 8,
        baseDelayMs: 500,
        shouldRetry: (err) => isTransientNetworkError(err) || String(err).includes('Friendbot funding failed: 5'),
      });
    } catch (err) {
      logger.warn(
        { err, label: process.env.ADMIN_SECRET ? 'ADMIN_SECRET' : 'throwaway admin', publicKey: adminPublicKey },
        'Friendbot funding skipped',
      );
    }
  }

  const accountService = new AccountService(config);
  try {
    const xlmBalance = await withRetry(() => accountService.getXlmBalance(adminPublicKey), {
      retries: 8,
      baseDelayMs: 500,
      shouldRetry: isTransientNetworkError,
    });
    logger.info({ publicKey: adminPublicKey }, 'Admin account');
    logger.info({ publicKey: adminPublicKey, xlmBalance }, 'XLM balance');
  } catch (err) {
    logger.warn({ err, publicKey: adminPublicKey }, 'Skipping XLM balance check');
  }
}

async function main(): Promise<void> {
  const safety = loadSafetyFeatures();
  const twWHPubKey = safety.trustlessWorkWebhookPublicKey;
  logger.info(
    {
      pauseNewTasks: safety.pauseNewTasks,
      pauseNewBids: safety.pauseNewBids,
      pauseWorkerConsumption: safety.pauseWorkerConsumption,
      escrowImplementation: safety.escrowImplementation,
      executorDenylistSize: safety.executorDenylist.size,
      executorDenylistPreview: [...safety.executorDenylist].slice(0, 3),
      trustlessWorkWebhookPublicKeySet: twWHPubKey !== undefined,
      trustlessWorkWebhookPublicKeyLen: twWHPubKey?.length,
      trustlessWorkWebhookPublicKeySha256Prefix8: twWHPubKey
        ? createHash('sha256').update(twWHPubKey).digest('hex').slice(0, 8)
        : undefined,
    },
    'Safety features loaded',
  );

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
    const mockExternals = shouldMockExternals() && config.network === 'local';
    const escrowService = mockExternals
      ? new MockEscrowService()
      : (() => {
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
          return new EscrowService({
            apiKey: trustlessWorkApiKey,
            network: config.network === 'pubnet' ? 'mainnet' : 'testnet',
            marketplaceWallet,
            usdcIssuer,
          });
        })();

    const outboxService = new OutboxService(outbox);
    const parsedWebhookMaxRetries = Number(process.env.WEBHOOK_MAX_RETRIES);
    const webhookMaxRetries =
      Number.isFinite(parsedWebhookMaxRetries) && parsedWebhookMaxRetries >= 0
        ? Math.trunc(parsedWebhookMaxRetries)
        : 3;
    const parsedWebhookBaseBackoffMs = Number(process.env.WEBHOOK_BASE_BACKOFF_MS);
    const webhookBaseBackoffMs =
      Number.isFinite(parsedWebhookBaseBackoffMs) && parsedWebhookBaseBackoffMs >= 50
        ? Math.trunc(parsedWebhookBaseBackoffMs)
        : 1000;
    const webhookService = new WebhookService({
      timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 5000),
      maxRetries: webhookMaxRetries,
      baseBackoffMs: webhookBaseBackoffMs,
    });
    const redis = await getRedisClient();
    const parsedBacklogSampleMs = Number(process.env.OUTBOX_BACKLOG_SAMPLE_MS);
    const backlogSampleIntervalMs =
      Number.isFinite(parsedBacklogSampleMs) && parsedBacklogSampleMs >= 1000
        ? Math.trunc(parsedBacklogSampleMs)
        : 5000;
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
        backlogSampleIntervalMs,
      },
      safety,
    );
    await worker.start();
  }

  app.listen(port, () => {
    logger.info({ port, nodeEnv: process.env.NODE_ENV ?? 'development' }, 'TrustGate server listening');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
