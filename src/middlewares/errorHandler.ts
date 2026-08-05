import { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error(
    {
      err,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      remoteAddress: req.ip,
      requestId: req.headers['x-request-id'] ?? undefined,
    },
    'Unhandled error',
  );

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: 'Internal Server Error',
    detail: err instanceof Error ? err.message : String(err),
  });
}
