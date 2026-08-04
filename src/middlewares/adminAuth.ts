import { NextFunction, Request, Response } from 'express';

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-admin-secret');
  const expected = process.env.ADMIN_SECRET;

  if (!expected || !provided || provided !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}
