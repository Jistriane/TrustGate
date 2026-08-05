import { join } from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'TrustGate API',
      version: '0.1.0',
      description:
        'Stellar x402/MPP task marketplace: executors register on-chain, requesters list ' +
        'tasks and pay a USDC listing fee, executors bid with escrowed collateral, the ' +
        'marketplace selects a winner, and payment/escrow settle on completion.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local/dev' }],
    components: {
      securitySchemes: {
        adminAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-admin-secret',
          description: 'Shared secret matching the server\'s ADMIN_SECRET env var.',
        },
        tgSignedRequest: {
          type: 'apiKey',
          in: 'header',
          name: 'x-tg-signature',
          description:
            'Signed request authentication (testnet/pubnet). Requires headers: x-tg-public-key, x-tg-timestamp, ' +
            'x-tg-nonce, x-tg-signature (base64 recommended). Canonical payload: METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256(rawBody). ' +
            'Use POST /auth/nonce to obtain a server-issued nonce+timestamp.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            detail: {},
          },
          required: ['error'],
        },
        Task: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            requesterPublicKey: { type: 'string', description: 'Stellar public key (G...)' },
            reservePrice: { type: 'string', description: 'USDC decimal string (up to 7 decimals)' },
            reservePriceStroops: { type: 'string', description: 'USDC amount in stroops (7 decimals), as string' },
            description: { type: 'string' },
            deadline: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['OPEN', 'ASSIGNED', 'COMPLETING', 'COMPLETED', 'EXPIRED'] },
          },
          required: [
            'id',
            'requesterPublicKey',
            'reservePrice',
            'reservePriceStroops',
            'description',
            'deadline',
            'status',
          ],
        },
        Bid: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            taskId: { type: 'string' },
            executorPublicKey: { type: 'string', description: 'Stellar public key (G...)' },
            amount: { type: 'string', description: 'USDC decimal string (up to 7 decimals)' },
            amountStroops: { type: 'string', description: 'USDC amount in stroops (7 decimals), as string' },
            collateral: { type: 'string', description: 'USDC decimal string (up to 7 decimals)' },
            collateralStroops: { type: 'string', description: 'USDC amount in stroops (7 decimals), as string' },
            escrowId: { type: 'string' },
            status: { type: 'string', enum: ['PENDING', 'SELECTED', 'REJECTED'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
          required: [
            'id',
            'taskId',
            'executorPublicKey',
            'amount',
            'amountStroops',
            'collateral',
            'collateralStroops',
            'escrowId',
            'status',
            'createdAt',
          ],
        },
        ReleaseResult: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            transactionHash: { type: 'string' },
            amountReleased: { type: 'number', description: 'USDC decimal amount (Trustless Work API)' },
            receiver: { type: 'string', description: 'Stellar public key (G...)' },
          },
          required: ['success', 'transactionHash', 'amountReleased', 'receiver'],
        },
        TaskCompletionAccepted: {
          type: 'object',
          properties: {
            task: { $ref: '#/components/schemas/Task' },
          },
          required: ['task'],
        },
        TaskCompletionImmediate: {
          type: 'object',
          properties: {
            task: { $ref: '#/components/schemas/Task' },
            release: { $ref: '#/components/schemas/ReleaseResult' },
          },
          required: ['task', 'release'],
        },
      },
    },
  },
  // Matches whichever of these exists: app.ts under ts-node/dev, app.js in
  // the compiled dist/ build. tsc preserves comments by default, so the
  // @openapi JSDoc blocks below survive into the compiled output too.
  apis: [join(__dirname, '..', 'app.ts'), join(__dirname, '..', 'app.js')],
});
