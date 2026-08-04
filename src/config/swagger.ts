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
            requester: { type: 'string', description: 'Stellar public key (G...)' },
            reservePrice: { type: 'number' },
            description: { type: 'string' },
            deadline: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['OPEN', 'ASSIGNED', 'COMPLETED', 'EXPIRED'] },
          },
        },
        Bid: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            taskId: { type: 'string' },
            executor: { type: 'string', description: 'Stellar public key (G...)' },
            amount: { type: 'number' },
            collateral: { type: 'number' },
            escrowId: { type: 'string' },
            status: { type: 'string', enum: ['PENDING', 'SELECTED', 'REJECTED'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  // Matches whichever of these exists: app.ts under ts-node/dev, app.js in
  // the compiled dist/ build. tsc preserves comments by default, so the
  // @openapi JSDoc blocks below survive into the compiled output too.
  apis: [join(__dirname, '..', 'app.ts'), join(__dirname, '..', 'app.js')],
});
