import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { Keypair } from '@stellar/stellar-sdk';
import { requestLogger } from './middlewares/requestLogger';
import { metricsRegistry } from './config/metrics';
import { swaggerSpec } from './config/swagger';
import { HealthCheckService } from './services/healthCheckService';
import { loadStellarConfig } from './config/stellar';
import { getUsdcSacContractId } from './config/usdc';
import { RegistryService, RegistryServiceLike } from './services/registryService';
import { MppChargeService, MppChargeServiceLike } from './services/mppChargeService';
import { FeedTick, TaskFeedService } from './services/taskFeedService';
import { calculateListingFee } from './services/listingFee';
import { createTaskSchema } from './models/taskSchema';
import { createListingFeeGateFactory } from './config/mppCharge';
import { EscrowService, EscrowServiceLike } from './services/escrowService';
import { AuctionService } from './services/auctionService';
import { TimeoutService } from './services/timeoutService';
import { ExecutorRepository } from './repositories/executorRepository';
import { TaskRepository } from './repositories/taskRepository';
import { BidRepository } from './repositories/bidRepository';
import { ExecutorResultService } from './services/executorResultService';
import { ExecutorController } from './controllers/executorController';
import { TaskController } from './controllers/taskController';
import { BidController } from './controllers/bidController';
import { ExecutorResultController } from './controllers/executorResultController';
import { errorHandler } from './middlewares/errorHandler';
import { adminAuth } from './middlewares/adminAuth';
import { createResultPaymentGate } from './config/x402';

export interface AppOverrides {
  /** Swap the real Registry/Soroban integration for a fake — e2e/mocked tests. */
  registryService?: RegistryServiceLike;
  /** Swap the real USDC SAC charge integration for a fake — e2e/mocked tests. */
  mppChargeService?: MppChargeServiceLike;
  /** Swap the real Trustless Work integration for a fake — e2e/mocked tests. */
  escrowService?: EscrowServiceLike;
  /** Swap the real MPP Charge gate (testnet/pubnet listing-fee path) for a fake — tests. */
  listingFeeGateFactory?: (amount: string, description: string) => Promise<RequestHandler>;
}

export function createApp(overrides: AppOverrides = {}): Express {
  const config = loadStellarConfig();

  const marketplaceWallet =
    process.env.MARKETPLACE_WALLET ??
    (process.env.ADMIN_SECRET ? Keypair.fromSecret(process.env.ADMIN_SECRET).publicKey() : undefined);
  if (!marketplaceWallet) {
    throw new Error('MARKETPLACE_WALLET or ADMIN_SECRET must be set');
  }

  let registryService: RegistryServiceLike;
  if (overrides.registryService) {
    registryService = overrides.registryService;
  } else {
    const registryContractId = process.env.REGISTRY_CONTRACT_ID;
    if (!registryContractId) {
      throw new Error('REGISTRY_CONTRACT_ID is not set');
    }
    registryService = new RegistryService(config, registryContractId);
  }
  const executorRepository = new ExecutorRepository();
  const executorController = new ExecutorController(registryService, executorRepository);

  let feedSigningKey: Keypair;
  if (process.env.ADMIN_SECRET) {
    feedSigningKey = Keypair.fromSecret(process.env.ADMIN_SECRET);
  } else {
    feedSigningKey = Keypair.random();
    console.warn(
      `No ADMIN_SECRET set — generated ephemeral task feed signing key ${feedSigningKey.publicKey()}`,
    );
  }

  const mppChargeService =
    overrides.mppChargeService ??
    new MppChargeService(config, getUsdcSacContractId(config), marketplaceWallet);
  const taskFeedService = new TaskFeedService(feedSigningKey);
  const taskRepository = new TaskRepository();
  const bidRepository = new BidRepository();
  const auctionService = new AuctionService(taskRepository, bidRepository);

  let listingFeeGateFactory: ((amount: string, description: string) => Promise<RequestHandler>) | undefined;
  if (config.network !== 'local') {
    if (overrides.listingFeeGateFactory) {
      listingFeeGateFactory = overrides.listingFeeGateFactory;
    } else {
      const mppSecretKey = process.env.MPP_SECRET_KEY;
      if (!mppSecretKey) {
        throw new Error('MPP_SECRET_KEY is not set (required for POST /tasks on testnet/pubnet)');
      }
      listingFeeGateFactory = createListingFeeGateFactory({
        stellarConfig: config,
        usdcSacContractId: getUsdcSacContractId(config),
        marketplaceWallet,
        mppSecretKey,
      });
    }
  }

  let escrowService: EscrowServiceLike;
  if (overrides.escrowService) {
    escrowService = overrides.escrowService;
  } else {
    const trustlessWorkApiKey = process.env.TRUSTLESS_WORK_API_KEY;
    if (!trustlessWorkApiKey) {
      throw new Error('TRUSTLESS_WORK_API_KEY is not set');
    }
    const usdcIssuer = process.env.USDC_ISSUER;
    if (!usdcIssuer) {
      throw new Error('USDC_ISSUER is not set');
    }
    escrowService = new EscrowService({
      apiKey: trustlessWorkApiKey,
      network: config.network === 'pubnet' ? 'mainnet' : 'testnet',
      marketplaceWallet,
      usdcIssuer,
    });
  }

  const taskController = new TaskController(
    mppChargeService,
    taskRepository,
    taskFeedService,
    auctionService,
    escrowService,
    bidRepository,
  );
  const bidController = new BidController(taskRepository, escrowService, bidRepository);
  const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);

  const app = express();
  app.use(helmet());
  app.use(cors());
  if (process.env.NODE_ENV !== 'test') {
    app.use(requestLogger);
  }
  app.use(express.json());

  // Swagger UI's page needs inline scripts/styles to bootstrap; helmet's
  // default CSP (script-src 'self', etc.) blocks that. Strip the CSP header
  // for just this path rather than weakening it for the whole app.
  app.use(
    '/api-docs',
    (_req: Request, res: Response, next: NextFunction) => {
      res.removeHeader('Content-Security-Policy');
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec),
  );

  /**
   * @openapi
   * /health:
   *   get:
   *     summary: Liveness check
   *     tags: [Health]
   *     responses:
   *       200:
   *         description: The server is up.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status: { type: string, example: ok }
   */
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const healthCheckService = new HealthCheckService(config);
  /**
   * @openapi
   * /health/detailed:
   *   get:
   *     summary: Dependency health check (Stellar RPC, Redis)
   *     tags: [Health]
   *     responses:
   *       200:
   *         description: All dependencies are healthy.
   *       503:
   *         description: One or more dependencies are down.
   *     x-example-response:
   *       status: ok
   *       dependencies:
   *         stellarRpc: { status: up, latencyMs: 33 }
   *         redis: { status: up, latencyMs: 4 }
   */
  app.get('/health/detailed', async (_req, res) => {
    const health = await healthCheckService.check();
    res.status(health.status === 'ok' ? 200 : 503).json(health);
  });

  /**
   * @openapi
   * /metrics:
   *   get:
   *     summary: Prometheus metrics (Node.js process/runtime stats)
   *     tags: [Health]
   *     responses:
   *       200:
   *         description: Metrics in Prometheus text exposition format.
   *         content:
   *           text/plain:
   *             schema: { type: string }
   */
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  });

  /**
   * @openapi
   * /executors/register:
   *   post:
   *     summary: Register an executor on the on-chain allow-list
   *     tags: [Executors]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [secret, metadataUri]
   *             properties:
   *               secret: { type: string, description: "Executor's Stellar secret key (S...)" }
   *               metadataUri: { type: string, format: uri }
   *     responses:
   *       201:
   *         description: Registered.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 publicKey: { type: string }
   *                 metadataUri: { type: string }
   *                 registeredAt: { type: string, format: date-time }
   *       400:
   *         description: Invalid secret or missing fields.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       409:
   *         description: Registration failed (e.g. already registered).
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   */
  app.post('/executors/register', executorController.register);

  /**
   * @openapi
   * /tasks:
   *   post:
   *     summary: List a task (charges the requester a 0.5% USDC listing fee)
   *     description: >
   *       On `NETWORK=local` (dev/CI only), the requester's secret is sent
   *       directly and the server signs the listing-fee transfer itself. On
   *       testnet/pubnet, this route is gated behind the real MPP Charge
   *       protocol instead: an initial request with no payment credential
   *       gets a `402` challenge back; the client signs the SAC transfer's
   *       auth entry with its own key and resubmits with the credential
   *       header — the secret is never sent to this server, so the request
   *       body has no `secret` field in that mode.
   *     tags: [Tasks]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [requester, reservePrice, description, deadline]
   *             properties:
   *               requester: { type: string, description: "Stellar public key (G...)" }
   *               secret: { type: string, description: "Requester's Stellar secret key (S...) — local network only" }
   *               reservePrice: { type: number }
   *               description: { type: string }
   *               deadline: { type: string, format: date-time }
   *     responses:
   *       201:
   *         description: Task created.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Task' } } }
   *       400:
   *         description: Invalid request.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       402:
   *         description: Payment required — insufficient USDC balance (local network), or an MPP payment challenge (testnet/pubnet).
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       502:
   *         description: Listing fee charge failed (network error).
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   */
  if (listingFeeGateFactory) {
    app.post(
      '/tasks',
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const parsed = createTaskSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
          return;
        }

        const amount = calculateListingFee(parsed.data.reservePrice).toString();
        const description = `Listing fee for task by ${parsed.data.requester}`;
        const gate = await listingFeeGateFactory(amount, description);
        gate(req, res, next);
      },
      taskController.createPaid,
    );
  } else {
    app.post('/tasks', taskController.create);
  }

  /**
   * @openapi
   * /tasks/{id}/select:
   *   post:
   *     summary: Select the winning bid for a task (admin only)
   *     tags: [Tasks]
   *     security: [{ adminAuth: [] }]
   *     parameters:
   *       - { name: id, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: Winner selected; task moves to ASSIGNED.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 task: { $ref: '#/components/schemas/Task' }
   *                 winningBid: { $ref: '#/components/schemas/Bid' }
   *       401:
   *         description: Missing or incorrect x-admin-secret header.
   *       404:
   *         description: Task not found.
   *       409:
   *         description: Task not OPEN, or no pending bids.
   */
  app.post('/tasks/:id/select', adminAuth, taskController.select);

  /**
   * @openapi
   * /tasks/{id}/complete:
   *   post:
   *     summary: Mark a task complete and release the winning bid's escrow (requester only)
   *     tags: [Tasks]
   *     parameters:
   *       - { name: id, in: path, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [requester, secret]
   *             properties:
   *               requester: { type: string, description: "Stellar public key (G...)" }
   *               secret: { type: string, description: "Requester's Stellar secret key (S...)" }
   *     responses:
   *       200:
   *         description: Escrow released; task moves to COMPLETED.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 task: { $ref: '#/components/schemas/Task' }
   *                 release:
   *                   type: object
   *                   properties:
   *                     success: { type: boolean }
   *                     transactionHash: { type: string }
   *                     amountReleased: { type: number }
   *                     receiver: { type: string }
   *       400:
   *         description: Invalid request or secret mismatch.
   *       403:
   *         description: Caller is not the task's requester.
   *       404:
   *         description: Task not found.
   *       409:
   *         description: Task not ASSIGNED, or no selected bid.
   *       502:
   *         description: Escrow release failed (network error).
   */
  app.post('/tasks/:id/complete', taskController.complete);

  /**
   * @openapi
   * /bids:
   *   post:
   *     summary: Submit a bid on an OPEN task, locking collateral in escrow
   *     tags: [Bids]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [taskId, executor, secret, amount, collateral]
   *             properties:
   *               taskId: { type: string }
   *               executor: { type: string, description: "Stellar public key (G...)" }
   *               secret: { type: string, description: "Executor's Stellar secret key (S...)" }
   *               amount: { type: number }
   *               collateral: { type: number }
   *     responses:
   *       201:
   *         description: Bid created; collateral escrowed.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Bid' } } }
   *       400:
   *         description: Invalid request or secret mismatch.
   *       404:
   *         description: Task not found.
   *       409:
   *         description: Task not OPEN.
   *       502:
   *         description: Escrow creation failed (network error).
   */
  app.post('/bids', bidController.create);

  /**
   * @openapi
   * /admin/timeout-check:
   *   post:
   *     summary: Manually run the expired-task sweep (confiscates collateral, marks EXPIRED)
   *     tags: [Admin]
   *     security: [{ adminAuth: [] }]
   *     responses:
   *       200:
   *         description: Sweep completed.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 expiredTaskIds: { type: array, items: { type: string } }
   *       401:
   *         description: Missing or incorrect x-admin-secret header.
   */
  app.post('/admin/timeout-check', adminAuth, async (_req, res) => {
    try {
      const result = await timeoutService.runOnce();
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: 'timeout check failed', detail: (err as Error).message });
    }
  });

  const ozApiKey = process.env.OZ_API_KEY;
  if (ozApiKey) {
    const executorResultService = new ExecutorResultService();
    const executorResultController = new ExecutorResultController(executorResultService);
    const resultPaymentGate = createResultPaymentGate({
      network: process.env.X402_NETWORK ?? 'stellar:testnet',
      recipient: process.env.EXECUTOR_WALLET ?? marketplaceWallet,
      price: process.env.EXECUTOR_RESULT_PRICE ?? '$0.05',
      ozApiKey,
      facilitatorUrl:
        process.env.X402_FACILITATOR_URL ?? 'https://channels.openzeppelin.com/x402/testnet',
      route: 'GET /executor/tasks/:taskId/result',
      description: 'Task result delivery',
    });
    /**
     * @openapi
     * /executor/tasks/{taskId}/result:
     *   get:
     *     summary: Fetch a task's result, gated behind an x402 payment (only mounted when OZ_API_KEY is set)
     *     tags: [Executor]
     *     parameters:
     *       - { name: taskId, in: path, required: true, schema: { type: string } }
     *     responses:
     *       200:
     *         description: Payment settled; result returned.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 taskId: { type: string }
     *                 resultHash: { type: string }
     *                 link: { type: string, format: uri }
     *       402:
     *         description: Payment required — response carries x402 payment requirements.
     *       503:
     *         description: The OZ Channels facilitator is unreachable.
     */
    app.get('/executor/tasks/:taskId/result', resultPaymentGate, executorResultController.getResult);
  } else {
    console.warn('OZ_API_KEY is not set — /executor/tasks/:taskId/result is not mounted');
  }

  /**
   * @openapi
   * /feed/stream:
   *   get:
   *     summary: Server-Sent Events stream of new-task ticks (free, unauthenticated — not a paid channel)
   *     tags: [Feed]
   *     responses:
   *       200:
   *         description: text/event-stream of FeedTick JSON payloads.
   *         content:
   *           text/event-stream:
   *             schema: { type: string }
   */
  app.get('/feed/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onTick = (tick: FeedTick): void => {
      res.write(`data: ${JSON.stringify(tick)}\n\n`);
    };
    taskFeedService.on('tick', onTick);

    req.on('close', () => {
      taskFeedService.off('tick', onTick);
    });
  });

  app.use(errorHandler);

  app.set('taskFeedService', taskFeedService);
  app.set('taskRepository', taskRepository);
  app.set('bidRepository', bidRepository);
  app.set('timeoutService', timeoutService);

  return app;
}
