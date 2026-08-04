import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../config/logger';

const REQUEST_ID_HEADER = 'x-request-id';

const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req.headers[REQUEST_ID_HEADER] as string) || randomUUID(),
});

/** Structured request/response logging with request-id correlation. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  httpLogger(req, res, () => {
    res.setHeader('X-Request-Id', String(req.id));
    next();
  });
}
