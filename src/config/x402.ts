import { NextFunction, Request, RequestHandler, Response } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';

export interface X402GateConfig {
  network: string;
  recipient: string;
  price: string;
  ozApiKey: string;
  facilitatorUrl: string;
  route: string;
  description: string;
}

export function createResultPaymentGate(config: X402GateConfig): RequestHandler {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: async () => {
      const headers = { Authorization: `Bearer ${config.ozApiKey}` };
      return { verify: headers, settle: headers, supported: headers };
    },
  });

  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network as never,
    new ExactStellarScheme(),
  );

  const x402Middleware = paymentMiddleware(
    {
      [config.route]: {
        accepts: {
          scheme: 'exact',
          price: config.price,
          network: config.network as never,
          payTo: config.recipient,
        },
        description: config.description,
      },
    },
    resourceServer,
    undefined,
    undefined,
    false,
  );

  // syncFacilitatorOnStart is false above so app boot never blocks on (or
  // crashes from) an unreachable facilitator; instead we sync it once here,
  // lazily, on first request, and surface a clean 503 if that sync fails
  // rather than letting the underlying "facilitator does not support ..."
  // error fall through as a generic 500.
  let initPromise: Promise<void> | undefined;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!initPromise) {
      initPromise = resourceServer.initialize().catch((err) => {
        initPromise = undefined;
        throw err;
      });
    }

    initPromise
      .then(() => x402Middleware(req, res, next))
      .catch((err: Error) => {
        res.status(503).json({
          error: 'payment gate unavailable',
          detail: err.message,
        });
      });
  };
}
