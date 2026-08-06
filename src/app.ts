import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { Keypair } from '@stellar/stellar-sdk';
import { logger } from './config/logger';
import { requestLogger } from './middlewares/requestLogger';
import { metricsRegistry } from './config/metrics';
import { swaggerSpec } from './config/swagger';
import { HealthCheckService } from './services/healthCheckService';
import { loadStellarConfig } from './config/stellar';
import { getUsdcSacContractId } from './config/usdc';
import { RegistryService, RegistryServiceLike } from './services/registryService';
import { MppChargeService, MppChargeServiceLike } from './services/mppChargeService';
import { FeedTick, TaskFeedService } from './services/taskFeedService';
import { PolicyService } from './services/policyService';
import { calculateListingFeeStroops } from './services/listingFee';
import { createTaskSchema } from './models/taskSchema';
import { createListingFeeGateFactory } from './config/mppCharge';
import { EscrowService, IProviderEscrow } from './services/escrowService';
import { loadSafetyFeatures, SafetyFeatures } from './config/safetyFeatures';
import { AuctionService } from './services/auctionService';
import { TimeoutService } from './services/timeoutService';
import { InMemoryExecutorRepository, PgExecutorRepository } from './repositories/executorRepository';
import { InMemoryTaskRepository, PgTaskRepository } from './repositories/taskRepository';
import { InMemoryBidRepository, PgBidRepository } from './repositories/bidRepository';
import { InMemoryTaskResultRepository, PgTaskResultRepository } from './repositories/taskResultRepository';
import { PgOutboxRepository } from './repositories/outboxRepository';
import { PgIdempotencyRepository } from './repositories/idempotencyRepository';
import { ExecutorResultService } from './services/executorResultService';
import { OutboxService } from './services/outboxService';
import { ExecutorController } from './controllers/executorController';
import { TaskController } from './controllers/taskController';
import { BidController } from './controllers/bidController';
import { ExecutorResultController } from './controllers/executorResultController';
import { AuthController } from './controllers/authController';
import { errorHandler } from './middlewares/errorHandler';
import { adminAuth } from './middlewares/adminAuth';
import { createResultPaymentGate } from './config/x402';
import { getDbPool } from './db/pool';
import { formatUsdcStroopsToDecimal, parseUsdcDecimalToStroops } from './utils/money';
import { signatureAuth } from './middlewares/signatureAuth';
import { idempotency } from './middlewares/idempotency';
import {
  MockEscrowService,
  MockMppChargeService,
  MockRegistryService,
  shouldMockExternals,
} from './services/mockExternalServices';

export interface AppOverrides {
  /** Swap the real Registry/Soroban integration for a fake — e2e/mocked tests. */
  registryService?: RegistryServiceLike;
  /** Swap the real USDC SAC charge integration for a fake — e2e/mocked tests. */
  mppChargeService?: MppChargeServiceLike;
  /** Swap the real Trustless Work integration for a fake — e2e/mocked tests. */
  escrowService?: IProviderEscrow;
  /** Swap the real MPP Charge gate (testnet/pubnet listing-fee path) for a fake — tests. */
  listingFeeGateFactory?: (amount: string, description: string) => Promise<RequestHandler>;
  /** Inject a fake x402 payment middleware for the executor result endpoint in tests. */
  resultPaymentGate?: RequestHandler;
  /** Override pause/denylist safety features — tests. */
  safetyFeatures?: SafetyFeatures;
}

export function createApp(overrides: AppOverrides = {}): Express {
  const config = loadStellarConfig();
  const mockExternals = shouldMockExternals() && config.network === 'local';
  const safety = overrides.safetyFeatures ?? loadSafetyFeatures();

  const marketplaceWallet =
    process.env.MARKETPLACE_WALLET ??
    (process.env.ADMIN_SECRET ? Keypair.fromSecret(process.env.ADMIN_SECRET).publicKey() : undefined);
  if (!marketplaceWallet) {
    throw new Error('MARKETPLACE_WALLET or ADMIN_SECRET must be set');
  }

  let registryService: RegistryServiceLike;
  if (overrides.registryService) {
    registryService = overrides.registryService;
  } else if (mockExternals) {
    registryService = new MockRegistryService();
  } else {
    const registryContractId = process.env.REGISTRY_CONTRACT_ID;
    if (!registryContractId) {
      throw new Error('REGISTRY_CONTRACT_ID is not set');
    }
    registryService = new RegistryService(config, registryContractId);
  }

  const pool = process.env.DATABASE_URL ? getDbPool() : undefined;
  if (!pool && config.network !== 'local' && process.env.NODE_ENV !== 'test') {
    throw new Error('DATABASE_URL is not set (required for non-local networks)');
  }

  const executorRepository = pool ? new PgExecutorRepository(pool) : new InMemoryExecutorRepository();
  const executorController = new ExecutorController(registryService, executorRepository);

  let feedSigningKey: Keypair;
  if (process.env.ADMIN_SECRET) {
    feedSigningKey = Keypair.fromSecret(process.env.ADMIN_SECRET);
  } else {
    feedSigningKey = Keypair.random();
    logger.warn(
      { signingKeyPublicKey: feedSigningKey.publicKey() },
      'No ADMIN_SECRET set — generated ephemeral task feed signing key',
    );
  }

  const mppChargeService =
    overrides.mppChargeService ??
    (mockExternals ? new MockMppChargeService() : new MppChargeService(config, getUsdcSacContractId(config), marketplaceWallet));
  const taskFeedService = new TaskFeedService(feedSigningKey);
  const taskRepository = pool ? new PgTaskRepository(pool) : new InMemoryTaskRepository();
  const bidRepository = pool ? new PgBidRepository(pool) : new InMemoryBidRepository();
  const auctionService = new AuctionService(taskRepository, bidRepository);
  const policyService = new PolicyService(registryService);
  const outboxService = pool ? new OutboxService(new PgOutboxRepository(pool)) : undefined;
  const idempotencyRepo = pool ? new PgIdempotencyRepository(pool) : undefined;
  const idempotencyMw = (options: Parameters<typeof idempotency>[1]): RequestHandler =>
    idempotencyRepo ? idempotency(idempotencyRepo, options) : (_req, _res, next) => next();

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

  let escrowService: IProviderEscrow;
  if (overrides.escrowService) {
    escrowService = overrides.escrowService;
  } else if (mockExternals) {
    escrowService = new MockEscrowService();
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
    outboxService,
    safety,
  );
  const bidController = new BidController(
    taskRepository,
    escrowService,
    bidRepository,
    policyService,
    auctionService,
    outboxService,
    safety,
  );
  const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService, outboxService);

  const app = express();
  const trustProxyHopsRaw = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  const trustProxyHops = Number.isFinite(trustProxyHopsRaw) && trustProxyHopsRaw >= 0 ? Math.trunc(trustProxyHopsRaw) : 0;
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  app.use(helmet());
  app.use(cors());
  if (process.env.NODE_ENV !== 'test') {
    app.use(requestLogger);
  }
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

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

  const authController = new AuthController();
  /**
   * @openapi
   * /auth/nonce:
   *   post:
   *     summary: Issue a server nonce for signed requests (recommended for testnet)
   *     description: >
   *       Returns a one-time nonce stored in Redis. The client must include the returned
   *       `timestamp` and `nonce` in the signature headers for the next request.
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [publicKey]
   *             properties:
   *               publicKey: { type: string, description: "Stellar public key (G...)" }
   *     responses:
   *       200:
   *         description: Nonce issued.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [version, publicKey, timestamp, nonce, ttlSeconds]
   *               properties:
   *                 version: { type: integer, example: 1 }
   *                 publicKey: { type: string }
   *                 timestamp: { type: integer, description: "Server timestamp in ms" }
   *                 nonce: { type: string, description: "UUID" }
   *                 ttlSeconds: { type: integer, example: 600 }
   *       400:
   *         description: Invalid request.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       429:
   *         description: Rate limited.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       503:
   *         description: Redis unavailable.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   */
  app.post('/auth/nonce', authController.issueNonce);
  app.post(
    '/auth/signed-smoke',
    signatureAuth({ enforceInLocal: true, matchBodyField: 'publicKey' }),
    (req: Request, res: Response) => {
      res.status(200).json({ ok: true, publicKey: (req as unknown as { authPublicKey?: string }).authPublicKey });
    },
  );

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
   *     description: >
   *       On `NETWORK=local` (dev/CI only), the executor's secret is sent directly so
   *       the server can submit the on-chain registration transaction. On testnet/pubnet,
   *       no secret is ever sent; the caller proves ownership via signature headers and
   *       provides the `publicKey` explicitly.
   *     tags: [Executors]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             oneOf:
   *               - type: object
   *                 required: [secret, metadataUri]
   *                 properties:
   *                   secret: { type: string, description: "Executor's Stellar secret key (S...) — local network only" }
   *                   metadataUri: { type: string, format: uri }
   *               - type: object
   *                 required: [publicKey, metadataUri]
   *                 properties:
   *                   publicKey: { type: string, description: "Executor's Stellar public key (G...)" }
   *                   metadataUri: { type: string, format: uri }
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
  app.post(
    '/executors/register',
    signatureAuth({ matchBodyField: 'publicKey' }),
    idempotencyMw({ scope: 'executor_register', publicKeyFrom: { bodyField: 'publicKey' } }),
    executorController.register,
  );

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
   *               reservePrice: { type: string, description: "USDC decimal string (up to 7 decimals)" }
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

        const reservePriceStroops = parseUsdcDecimalToStroops(parsed.data.reservePrice);
        const feeStroops = calculateListingFeeStroops(reservePriceStroops);
        const amount = formatUsdcStroopsToDecimal(feeStroops);
        const description = `Listing fee for task by ${parsed.data.requester}`;
        const gate = await listingFeeGateFactory(amount, description);
        gate(req, res, next);
      },
      signatureAuth({ matchBodyField: 'requester' }),
      idempotencyMw({ scope: 'create_task', publicKeyFrom: { bodyField: 'requester' } }),
      taskController.createPaid,
    );
  } else {
    app.post(
      '/tasks',
      idempotencyMw({ scope: 'create_task', publicKeyFrom: { bodyField: 'requester' } }),
      taskController.create,
    );
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
  app.post('/tasks/:id/select', adminAuth, idempotencyMw({ scope: 'select_bid' }), taskController.select);

  /**
   * @openapi
   * /tasks/{id}:
   *   get:
   *     summary: Fetch a single task by id
   *     tags: [Tasks]
   *     parameters:
   *       - { name: id, in: path, required: true, schema: { type: string } }
   *     responses:
   *       200:
   *         description: Task.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Task' } } }
   *       404:
   *         description: Task not found.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   */
  app.get('/tasks/:id', taskController.getById);

  /**
   * @openapi
   * /tasks/{id}/complete:
   *   post:
   *     summary: Mark a task complete (requester only)
   *     description: >
   *       If Postgres+Outbox are enabled, this endpoint returns `202` and completes the escrow
   *       release asynchronously via the worker. Without Outbox (in-memory/local mode), it
   *       releases the escrow immediately and returns `200`.
   *     tags: [Tasks]
   *     parameters:
   *       - { name: id, in: path, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             oneOf:
   *               - type: object
   *                 required: [requester, secret]
   *                 properties:
   *                   requester: { type: string, description: "Stellar public key (G...)" }
   *                   secret: { type: string, description: "Requester's Stellar secret key (S...) — local network only" }
   *               - type: object
   *                 required: [requester]
   *                 properties:
   *                   requester: { type: string, description: "Stellar public key (G...)" }
   *     responses:
   *       200:
   *         description: Escrow released immediately; task moves to COMPLETED.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TaskCompletionImmediate'
   *       202:
   *         description: Completion accepted; escrow release will happen asynchronously.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/TaskCompletionAccepted'
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
  app.post(
    '/tasks/:id/complete',
    signatureAuth({ matchBodyField: 'requester' }),
    idempotencyMw({ scope: 'complete_task', publicKeyFrom: { bodyField: 'requester' } }),
    taskController.complete,
  );

  /**
   * @openapi
   * /bids:
   *   post:
   *     summary: Submit a bid on an OPEN task, locking collateral in escrow
   *     description: >
   *       On `NETWORK=local` (dev/CI only), the executor's secret is sent so the server can
   *       create the Trustless Work escrow. On testnet/pubnet, no secret is ever sent.
   *     tags: [Bids]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             oneOf:
   *               - type: object
   *                 required: [taskId, executor, secret, amount, collateral]
   *                 properties:
   *                   taskId: { type: string }
   *                   executor: { type: string, description: "Stellar public key (G...)" }
   *                   secret: { type: string, description: "Executor's Stellar secret key (S...) — local network only" }
   *                   amount: { type: string, description: "USDC decimal string (up to 7 decimals)" }
   *                   collateral: { type: string, description: "USDC decimal string (up to 7 decimals)" }
   *               - type: object
   *                 required: [taskId, executor, amount, collateral]
   *                 properties:
   *                   taskId: { type: string }
   *                   executor: { type: string, description: "Stellar public key (G...)" }
   *                   amount: { type: string, description: "USDC decimal string (up to 7 decimals)" }
   *                   collateral: { type: string, description: "USDC decimal string (up to 7 decimals)" }
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
  app.post(
    '/bids',
    signatureAuth({ matchBodyField: 'executor' }),
    idempotencyMw({ scope: 'place_bid', publicKeyFrom: { bodyField: 'executor' } }),
    bidController.create,
  );

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

  let resultPaymentGate: RequestHandler | undefined = overrides.resultPaymentGate;
  const ozApiKey = process.env.OZ_API_KEY;
  if (!resultPaymentGate && ozApiKey) {
    resultPaymentGate = createResultPaymentGate({
      network: process.env.X402_NETWORK ?? 'stellar:testnet',
      recipient: process.env.EXECUTOR_WALLET ?? marketplaceWallet,
      price: process.env.EXECUTOR_RESULT_PRICE ?? '$0.05',
      ozApiKey,
      facilitatorUrl:
        process.env.X402_FACILITATOR_URL ?? 'https://channels.openzeppelin.com/x402/testnet',
      route: 'GET /executor/tasks/:taskId/result',
      description: 'Task result delivery',
    });
  }

  const taskResultRepository = pool ? new PgTaskResultRepository(pool) : new InMemoryTaskResultRepository();
  const executorResultService = new ExecutorResultService(taskResultRepository);
  const executorResultController = new ExecutorResultController(
    executorResultService,
    taskRepository,
    bidRepository,
    outboxService,
  );

  if (resultPaymentGate) {
    /**
     * @openapi
     * /executor/tasks/{taskId}/result:
     *   get:
     *     summary: Fetch a task's result, gated behind an x402 payment (only mounted when OZ_API_KEY is set or a resultPaymentGate override is provided)
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
     *                 payloadHash: { type: string, example: "sha256:..." }
     *                 payload: {}
     *       402:
     *         description: Payment required — response carries x402 payment requirements.
     *       404:
     *         description: Task or result not found.
     *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
     *       409:
     *         description: Task not in a result-available state, or no selected bid.
     *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
     *       503:
     *         description: The OZ Channels facilitator is unreachable.
     */
    app.get('/executor/tasks/:taskId/result', resultPaymentGate, executorResultController.getResult);
  } else {
    logger.warn('OZ_API_KEY is not set — GET /executor/tasks/:taskId/result is not mounted');
  }

  /**
   * @openapi
   * /executor/tasks/{taskId}/result:
   *   post:
   *     summary: Publish the result payload for an assigned task (selected executor only)
   *     description: >
   *       Stores the result server-side and emits `result_published` into the outbox (if enabled).
   *     tags: [Executor]
   *     parameters:
   *       - { name: taskId, in: path, required: true, schema: { type: string } }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [executorPublicKey, payload]
   *             properties:
   *               executorPublicKey: { type: string, description: "Stellar public key (G...)" }
   *               payload: {}
   *     responses:
   *       201:
   *         description: Result stored.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 taskId: { type: string }
   *                 payloadHash: { type: string, example: "sha256:..." }
   *       400:
   *         description: Invalid request.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       403:
   *         description: Only the selected executor can publish.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       404:
   *         description: Task not found.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   *       409:
   *         description: Task not ASSIGNED, or no selected bid.
   *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
   */
  app.post(
    '/executor/tasks/:taskId/result',
    signatureAuth({ matchBodyField: 'executorPublicKey' }),
    idempotencyMw({ scope: 'publish_result', publicKeyFrom: { bodyField: 'executorPublicKey' } }),
    executorResultController.publishResult,
  );

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
