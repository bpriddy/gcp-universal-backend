import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';

export async function healthCheck(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Light query to verify DB connectivity
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: 'ok',
      db: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

export function liveness(_req: Request, res: Response): void {
  // Simple liveness probe — does not check dependencies
  res.status(200).json({ status: 'ok' });
}
