import { NextFunction, Request, Response } from 'express';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('Unhandled error:', err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: 'Internal Server Error',
    detail: err instanceof Error ? err.message : String(err),
  });
}
