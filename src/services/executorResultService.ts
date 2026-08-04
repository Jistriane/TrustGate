export interface TaskResult {
  taskId: string;
  resultHash: string;
  link: string;
}

/**
 * Simulates an executor's delivery of a completed task's result.
 * Sprint 15's scope is the x402 payment gate in front of this endpoint,
 * not real result storage/retrieval — so this always returns fixed data.
 */
export class ExecutorResultService {
  getResult(taskId: string): TaskResult {
    return {
      taskId,
      resultHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      link: `https://executor.example.com/results/${taskId}`,
    };
  }
}
