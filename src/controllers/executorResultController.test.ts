import express from 'express';
import request from 'supertest';
import { ExecutorResultService } from '../services/executorResultService';
import { ExecutorResultController } from './executorResultController';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { InMemoryTaskResultRepository } from '../repositories/taskResultRepository';

let taskRepository: TaskRepository;
let bidRepository: BidRepository;
let service: ExecutorResultService;
let app: express.Express;

describe('ExecutorResultController.getResult', () => {
  beforeEach(() => {
    taskRepository = new TaskRepository();
    bidRepository = new BidRepository();
    service = new ExecutorResultService(new InMemoryTaskResultRepository());
    const controller = new ExecutorResultController(service, taskRepository, bidRepository);
    app = express();
    app.get('/executor/tasks/:taskId/result', controller.getResult);
  });

  it('returns 404 when the task does not exist', async () => {
    const response = await request(app).get('/executor/tasks/nonexistent/result');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'task not found' });
  });

  it('returns 409 when the task is not assigned', async () => {
    await taskRepository.save({
      id: 'task-1',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Do work',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'OPEN',
    });

    const response = await request(app).get('/executor/tasks/task-1/result');
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'task result is not available until the task is assigned' });
  });

  it('returns 409 when no selected bid exists', async () => {
    await taskRepository.save({
      id: 'task-2',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Do work',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'ASSIGNED',
    });

    const response = await request(app).get('/executor/tasks/task-2/result');
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'no selected executor for this task' });
  });

  it('returns 200 when task is assigned and selected bid exists', async () => {
    await taskRepository.save({
      id: 'task-3',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Do work',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'ASSIGNED',
    });
    await bidRepository.save({
      id: 'bid-1',
      taskId: 'task-3',
      executorPublicKey: 'GEXECUTOR',
      amountStroops: 500000000n,
      collateralStroops: 100000000n,
      escrowId: 'escrow-1',
      status: 'SELECTED',
      createdAt: new Date().toISOString(),
    });
    await service.publish('task-3', { ok: true });

    const response = await request(app).get('/executor/tasks/task-3/result');
    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe('task-3');
  });

  it('returns 200 when task is completed and selected bid exists', async () => {
    await taskRepository.save({
      id: 'task-4',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Do work',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'COMPLETED',
    });
    await bidRepository.save({
      id: 'bid-2',
      taskId: 'task-4',
      executorPublicKey: 'GEXECUTOR',
      amountStroops: 500000000n,
      collateralStroops: 100000000n,
      escrowId: 'escrow-2',
      status: 'SELECTED',
      createdAt: new Date().toISOString(),
    });
    await service.publish('task-4', { ok: true });

    const response = await request(app).get('/executor/tasks/task-4/result');
    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe('task-4');
  });
});
