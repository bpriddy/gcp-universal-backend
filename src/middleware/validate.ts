import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

/**
 * Factory that returns Express middleware which validates req.body
 * against the provided Zod schema.
 * On failure, throws a ZodError which is caught by the error handler.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return function (req: Request, _res: Response, next: NextFunction): void {
    try {
      req.body = schema.parse(req.body) as unknown;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Factory that returns Express middleware which validates req.params
 * against the provided Zod schema.
 */
export function validateParams<T>(schema: ZodSchema<T>) {
  return function (req: Request, _res: Response, next: NextFunction): void {
    try {
      req.params = schema.parse(req.params) as Record<string, string>;
      next();
    } catch (err) {
      next(err);
    }
  };
}
