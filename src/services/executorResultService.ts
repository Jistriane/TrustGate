import { createHash } from 'crypto';
import { TaskResultRepositoryLike, TaskResultRecord } from '../repositories/taskResultRepository';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface TaskResult {
  taskId: string;
  payload: unknown;
  payloadHash: string;
}

export class ExecutorResultService {
  constructor(private readonly repo: TaskResultRepositoryLike) {}

  async publish(taskId: string, payload: unknown): Promise<TaskResultRecord> {
    const canonical = JSON.stringify(canonicalize(payload));
    const payloadHash = `sha256:${sha256Hex(canonical)}`;

    await this.repo.upsert({ taskId, payload, payloadHash });
    const stored = await this.repo.findByTaskId(taskId);
    if (!stored) {
      throw new Error('failed to persist result');
    }
    return stored;
  }

  async get(taskId: string): Promise<TaskResultRecord | undefined> {
    return this.repo.findByTaskId(taskId);
  }
}
