import express from 'express';
import request from 'supertest';
import { ExecutorResultService } from '../services/executorResultService';
import { ExecutorResultController } from './executorResultController';

describe('ExecutorResultController.getResult', () => {
  it('returns 200 with the task result once past the payment gate', async () => {
    const controller = new ExecutorResultController(new ExecutorResultService());
    const app = express();
    app.get('/executor/tasks/:taskId/result', controller.getResult);

    const response = await request(app).get('/executor/tasks/task-abc/result');

    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe('task-abc');
    expect(response.body.resultHash).toMatch(/^sha256:/);
  });
});
