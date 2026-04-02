/**
 * userContext.ts
 *
 * AsyncLocalStorage-based user context propagation.
 *
 * Why AsyncLocalStorage?
 * Propagates the authenticated user's ID through the async call chain without
 * passing it explicitly to every function. The Prisma $extends middleware in
 * database.ts reads from here to inject `app.current_user_id` before each
 * query, enabling PostgreSQL RLS policies to filter rows per-user.
 *
 * Scope:
 * Set once per request by the setUserContext Express middleware (org router).
 * Auth routes do not set a context — they run without RLS (no user yet).
 * gub-admin uses the gub_admin role which has BYPASSRLS at the DB level.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface UserContext {
  userId: string;
  isAdmin: boolean;
}

export const userContextStorage = new AsyncLocalStorage<UserContext>();

export function getUserContext(): UserContext | undefined {
  return userContextStorage.getStore();
}
