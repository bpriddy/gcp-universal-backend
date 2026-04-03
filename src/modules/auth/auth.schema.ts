import { z } from 'zod';

export const GoogleLoginSchema = z.object({
  idToken: z
    .string()
    .min(1, 'idToken is required')
    .max(4096, 'idToken is too long')
    .regex(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/, 'idToken must be a valid JWT'),
  // Which app is the user logging into.  When provided, UserAppPermission is
  // checked and autoAccess provisioning is applied.  Omit for internal tools
  // that manage access outside this flow (e.g. gub-admin via IAP).
  appId: z.string().min(1).optional(),
});

export const RefreshSchema = z.object({
  refreshToken: z
    .string()
    .min(1, 'refreshToken is required')
    .max(512, 'refreshToken is too long'),
});

export const LogoutSchema = z.object({
  refreshToken: z
    .string()
    .min(1, 'refreshToken is required')
    .max(512, 'refreshToken is too long'),
});

export type GoogleLoginInput = z.infer<typeof GoogleLoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
export type LogoutInput = z.infer<typeof LogoutSchema>;
