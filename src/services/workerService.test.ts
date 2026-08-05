import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { OutboxPublisher } from './outboxPublisher';
import { EventConsumer } from './eventConsumer';
import { WorkerService } from './workerService';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WorkerService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not overlap ticks when publishIntervalMs is smaller than tick duration', async () => {
    jest.useFakeTimers();

    let activePublish = 0;
    let maxActivePublish = 0;

    jest.spyOn(OutboxPublisher.prototype, 'publishOnce').mockImplementation(async () => {
      activePublish += 1;
      maxActivePublish = Math.max(maxActivePublish, activePublish);
      await delay(50);
      activePublish -= 1;
      return 0;
    });

    jest.spyOn(EventConsumer.prototype, 'ensureGroup').mockResolvedValue(undefined);
    jest.spyOn(EventConsumer.prototype, 'autoClaimOnce').mockImplementation(async () => {
      await delay(100);
      return 0;
    });
    jest.spyOn(EventConsumer.prototype, 'pollOnce').mockImplementation(async () => {
      await delay(100);
      return 0;
    });
    jest.spyOn(EventConsumer.prototype, 'ack').mockResolvedValue(undefined);

    const outbox = {} as unknown as import('../repositories/outboxRepository').PgOutboxRepository;
    const consumptions = {
      listDueRetries: (jest.fn() as unknown as { mockResolvedValue: (v: unknown) => unknown }).mockResolvedValue([]),
      tryStart: (jest.fn() as unknown as { mockResolvedValue: (v: unknown) => unknown }).mockResolvedValue({
        started: false,
      }),
      markSucceeded: (jest.fn() as unknown as { mockResolvedValue: (v: unknown) => unknown }).mockResolvedValue(undefined),
      markFailed: (jest.fn() as unknown as { mockResolvedValue: (v: unknown) => unknown }).mockResolvedValue(undefined),
    } as unknown as import('../repositories/eventConsumptionRepository').PgEventConsumptionRepository;
    const taskRepository = {} as unknown as import('../repositories/taskRepository').PgTaskRepository;
    const bidRepository = {} as unknown as import('../repositories/bidRepository').PgBidRepository;
    const escrowService = {} as unknown as import('./escrowService').EscrowServiceLike;
    const outboxService = {} as unknown as import('./outboxService').OutboxService;
    const webhookService = {} as unknown as import('./webhookService').WebhookService;
    const redis = {} as unknown as import('redis').RedisClientType;

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
        streamKey: 's',
        publishIntervalMs: 10,
        consumerGroup: 'g',
        consumerName: 'c',
        maxAttempts: 3,
      },
    );

    const startPromise = worker.start();
    await jest.advanceTimersByTimeAsync(300);
    await startPromise;
    await jest.advanceTimersByTimeAsync(1000);
    worker.stop();

    expect(maxActivePublish).toBe(1);
  });
});
