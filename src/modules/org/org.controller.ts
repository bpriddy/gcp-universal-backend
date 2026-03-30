import type { Request, Response, NextFunction } from 'express';
import * as orgService from './org.service';
import { AccessDeniedError } from './org.types';

// ── Auth identity helpers ──────────────────────────────────────────────────
// req.user is guaranteed non-null on all org routes by the authenticate
// middleware applied at the router level. The ! assertions are safe here.

function identity(req: Request) {
  return {
    userId: req.user!.sub,
    isAdmin: req.user!.isAdmin,
  };
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof AccessDeniedError) {
    res.status(403).json({ code: err.code, message: err.message });
    return;
  }
  next(err);
}

// ── Accounts ───────────────────────────────────────────────────────────────

export async function listAccounts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const accounts = await orgService.listAccounts(userId, isAdmin);
    res.status(200).json(accounts);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function getAccount(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const account = await orgService.getAccount(req.params.id, userId, isAdmin);
    if (!account) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
      return;
    }
    res.status(200).json(account);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Campaigns ──────────────────────────────────────────────────────────────

export async function listCampaignsByAccount(
  req: Request<{ accountId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const campaigns = await orgService.listCampaignsByAccount(
      req.params.accountId,
      userId,
      isAdmin,
    );
    res.status(200).json(campaigns);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function getCampaign(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const campaign = await orgService.getCampaign(
      req.params.id,
      userId,
      isAdmin,
    );
    if (!campaign) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Campaign not found' });
      return;
    }
    res.status(200).json(campaign);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Staff ──────────────────────────────────────────────────────────────────
// Staff is a directory — no access control applied, any authenticated user can read.

export async function listStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const activeOnly = req.query['all'] !== 'true';
    const staff = await orgService.listStaff(userId, isAdmin, activeOnly);
    res.status(200).json(staff);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function getStaffMember(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const member = await orgService.getStaffMember(req.params.id);
    if (!member) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Staff member not found' });
      return;
    }
    res.status(200).json(member);
  } catch (err) {
    handleError(err, res, next);
  }
}
