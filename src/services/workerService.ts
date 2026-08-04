import { PgOutboxRepository } from '../repositories/outboxRepository';
import { RedisClientType } from 'redis';
import { OutboxPublisher } from './outboxPublisher';
import { EventConsumer } from './eventConsumer';
import { PgEventConsumptionRepository } from '../repositories/eventConsumptionRepository';
import { PgTaskRepository } from '../repositories/taskRepository';
import { PgBidRepository } from '../repositories/bidRepository';
import { EscrowServiceLike } from './escrowService';
import { OutboxService } from './outboxService';
import { WebhookService } from './webhookService';
import { toTaskDto } from '../presenters/taskPresenter';

export interface WorkerServiceOptions {
  streamKey: string;
  publishIntervalMs: number;
  consumerGroup: string;
  consumerName: string;
  maxAttempts: number;
  webhookUrl?: string;
}

export class WorkerService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outbox: PgOutboxRepository,
    private readonly consumptions: PgEventConsumptionRepository,
    private readonly taskRepository: PgTaskRepository,
    private readonly bidRepository: PgBidRepository,
    private readonly escrowService: EscrowServiceLike,
    private readonly outboxService: OutboxService,
    private readonly webhookService: WebhookService,
    private readonly redis: RedisClientType,
    private readonly options: WorkerServiceOptions,
  ) {}

  private computeBackoff(attempt: number): Date {
    const baseMs = 2000;
    const maxMs = 5 * 60 * 1000;
    const delay = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    return new Date(Date.now() + delay);
  }

  private async handleTaskCompletionRequested(eventId: string, payload: unknown): Promise<void> {
    const p = payload as { taskId?: string; escrowId?: string };
    const taskId = String(p.taskId ?? '');
    const escrowId = String(p.escrowId ?? '');
    if (!taskId || !escrowId) {
      throw new Error('invalid payload');
    }

    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new Error('task not found');
    }
    if (task.status === 'COMPLETED') {
      return;
    }
    if (task.status !== 'COMPLETING') {
      throw new Error(`task is not completing (status: ${task.status})`);
    }

    const winningBid = (await this.bidRepository.findByTaskId(taskId)).find((bid) => bid.status === 'SELECTED');
    if (!winningBid) {
      throw new Error('no selected bid found for this task');
    }

    const release = await this.escrowService.releaseMilestone(winningBid.escrowId);
    const updatedTask = { ...task, status: 'COMPLETED' as const };
    await this.taskRepository.save(updatedTask);
    await this.outboxService.emit({
      type: 'task_completed',
      aggregateType: 'task',
      aggregateId: updatedTask.id,
      payload: { task: toTaskDto(updatedTask), release, sourceEventId: eventId },
    });
  }

  private async handleResultPublished(eventId: string, payload: unknown): Promise<void> {
    if (!this.options.webhookUrl) return;
    const p = payload as { taskId?: string; executorPublicKey?: string; payloadHash?: string; publishedAt?: string };
    const taskId = String(p.taskId ?? '');
    const executorPublicKey = String(p.executorPublicKey ?? '');
    const payloadHash = String(p.payloadHash ?? '');
    const publishedAt = String(p.publishedAt ?? new Date().toISOString());
    if (!taskId || !executorPublicKey || !payloadHash) {
      throw new Error('invalid payload');
    }

    const res = await this.webhookService.postJson(this.options.webhookUrl, {
      eventId,
      type: 'result_published',
      taskId,
      executorPublicKey,
      payloadHash,
      publishedAt,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`webhook failed: ${res.status} ${res.bodyText}`);
    }
  }

  private async dispatch(eventId: string, type: string, payload: unknown): Promise<void> {
    if (type === 'task_completion_requested') {
      await this.handleTaskCompletionRequested(eventId, payload);
      return;
    }
    if (type === 'result_published') {
      await this.handleResultPublished(eventId, payload);
      return;
    }
  }

  async start(): Promise<void> {
    const publisher = new OutboxPublisher(this.outbox, this.redis, {
      streamKey: this.options.streamKey,
      batchSize: 50,
    });
    const consumer = new EventConsumer(this.redis, {
      streamKey: this.options.streamKey,
      group: this.options.consumerGroup,
      consumer: this.options.consumerName,
      blockMs: 2000,
      count: 20,
    });
    await consumer.ensureGroup();

    const tick = async () => {
      await publisher.publishOnce();
      await consumer.autoClaimOnce(30_000, async (entry) => {
        const eventId = String(entry.fields.id ?? '');
        const type = String(entry.fields.type ?? '');
        const payloadRaw = entry.fields.payload ?? 'null';
        if (!eventId || !type) {
          await consumer.ack(entry.id);
          return;
        }

        const handlerName = `event:${type}`;
        const started = await this.consumptions.tryStart({
          handlerName,
          eventId,
          streamEntryId: entry.id,
          maxAttempts: this.options.maxAttempts,
          nextRetryAt: null,
        });

        if (!started.started) {
          await consumer.ack(entry.id);
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          payload = null;
        }

        try {
          await this.dispatch(eventId, type, payload);
          await this.consumptions.markSucceeded(handlerName, eventId);
        } catch (err) {
          const attempt = started.record?.attempts ?? 1;
          await this.consumptions.markFailed({
            handlerName,
            eventId,
            error: (err as Error).message,
            nextRetryAt: this.computeBackoff(attempt),
          });
        } finally {
          await consumer.ack(entry.id);
        }
      });
      await consumer.pollOnce(async (entry) => {
        const eventId = String(entry.fields.id ?? '');
        const type = String(entry.fields.type ?? '');
        const payloadRaw = entry.fields.payload ?? 'null';
        if (!eventId || !type) {
          await consumer.ack(entry.id);
          return;
        }

        const handlerName = `event:${type}`;
        const started = await this.consumptions.tryStart({
          handlerName,
          eventId,
          streamEntryId: entry.id,
          maxAttempts: this.options.maxAttempts,
          nextRetryAt: null,
        });

        if (!started.started) {
          await consumer.ack(entry.id);
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          payload = null;
        }

        try {
          await this.dispatch(eventId, type, payload);
          await this.consumptions.markSucceeded(handlerName, eventId);
        } catch (err) {
          const attempt = started.record?.attempts ?? 1;
          await this.consumptions.markFailed({
            handlerName,
            eventId,
            error: (err as Error).message,
            nextRetryAt: this.computeBackoff(attempt),
          });
        } finally {
          await consumer.ack(entry.id);
        }
      });

      for (const handlerName of ['event:task_completion_requested', 'event:result_published']) {
        const due = await this.consumptions.listDueRetries({ handlerName, limit: 25 });
        for (const record of due) {
          const started = await this.consumptions.tryStart({
            handlerName: record.handlerName,
            eventId: record.eventId,
            maxAttempts: this.options.maxAttempts,
            nextRetryAt: null,
          });
          if (!started.started) continue;
          const event = await this.outbox.findById(record.eventId);
          if (!event) {
            await this.consumptions.markFailed({
              handlerName: record.handlerName,
              eventId: record.eventId,
              error: 'outbox event not found',
              nextRetryAt: this.computeBackoff(started.record?.attempts ?? record.attempts),
            });
            continue;
          }
          try {
            await this.dispatch(event.id, event.type, event.payload);
            await this.consumptions.markSucceeded(record.handlerName, record.eventId);
          } catch (err) {
            const attempt = started.record?.attempts ?? record.attempts;
            await this.consumptions.markFailed({
              handlerName: record.handlerName,
              eventId: record.eventId,
              error: (err as Error).message,
              nextRetryAt: this.computeBackoff(attempt),
            });
          }
        }
      }
    };

    await tick();
    this.timer = setInterval(() => {
      tick().catch((err) => console.error('[Worker] tick failed:', err));
    }, this.options.publishIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
