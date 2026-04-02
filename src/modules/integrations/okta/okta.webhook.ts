import type { Request, Response } from 'express';
import { fetchOktaUserById } from './okta.client';
import { applyOktaUser } from './okta.sync';
import { logger } from '../../../services/logger';

// ── Okta Event Hook types ─────────────────────────────────────────────────────

interface OktaEventTarget {
  id: string;
  type: string;
  displayName?: string;
}

interface OktaEvent {
  uuid: string;
  eventType: string;
  target?: OktaEventTarget[];
}

interface OktaHookPayload {
  data: {
    events: OktaEvent[];
  };
}

// ── Events we care about ──────────────────────────────────────────────────────

const RELEVANT_EVENT_TYPES = new Set([
  'user.lifecycle.create',
  'user.lifecycle.activate',
  'user.lifecycle.deactivate',
  'user.lifecycle.suspend',
  'user.lifecycle.unsuspend',
  'user.account.update_profile',
]);

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * GET /integrations/okta/webhook
 *
 * One-time Okta Event Hook verification challenge.
 * Okta sends a GET with the header `x-okta-verification-challenge`; we echo
 * back { verification: <value> } to prove we control the endpoint.
 */
export function handleOktaChallenge(req: Request, res: Response): void {
  const challenge = req.headers['x-okta-verification-challenge'];

  if (!challenge || typeof challenge !== 'string') {
    res.status(400).json({ error: 'Missing x-okta-verification-challenge header' });
    return;
  }

  res.json({ verification: challenge });
}

/**
 * POST /integrations/okta/webhook
 *
 * Receives Okta Event Hook event batches. We respond 200 immediately (Okta
 * retries on timeout) and process asynchronously in the background.
 */
export function handleOktaWebhook(req: Request, res: Response): void {
  // Acknowledge immediately so Okta doesn't retry due to timeout
  res.status(200).json({ status: 'ok' });

  void processEvents(req.body as OktaHookPayload);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function processEvents(payload: OktaHookPayload): Promise<void> {
  const events: OktaEvent[] = payload?.data?.events ?? [];

  for (const event of events) {
    if (!RELEVANT_EVENT_TYPES.has(event.eventType)) continue;

    // Find the User target in the event
    const userTarget = event.target?.find((t) => t.type === 'User');
    if (!userTarget) {
      logger.warn({ eventType: event.eventType, uuid: event.uuid }, 'Okta webhook: event has no User target');
      continue;
    }

    try {
      // Fetch fresh user state from Okta rather than relying on stale event data
      const user = await fetchOktaUserById(userTarget.id);

      if (!user) {
        logger.warn({ oktaId: userTarget.id, eventType: event.eventType }, 'Okta webhook: user not found in Okta');
        continue;
      }

      await applyOktaUser(user, 'okta_webhook');
      logger.info({ oktaId: userTarget.id, eventType: event.eventType }, 'Okta webhook: applied user change');
    } catch (err) {
      logger.error(
        { err, oktaId: userTarget.id, eventType: event.eventType, uuid: event.uuid },
        'Okta webhook: failed to process event',
      );
    }
  }
}
