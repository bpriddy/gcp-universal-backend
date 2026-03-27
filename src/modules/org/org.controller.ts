import type { Request, Response, NextFunction } from 'express';
import * as orgService from './org.service';

// ── Accounts ───────────────────────────────────────────────────────────────

export async function listAccounts(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const accounts = await orgService.listAccounts();
    res.status(200).json(accounts);
  } catch (err) {
    next(err);
  }
}

export async function getAccount(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const account = await orgService.getAccount(req.params.id);
    if (!account) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
      return;
    }
    res.status(200).json(account);
  } catch (err) {
    next(err);
  }
}

// ── Campaigns ──────────────────────────────────────────────────────────────

export async function listCampaignsByAccount(
  req: Request<{ accountId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Verify the account exists before returning its campaigns
    const account = await orgService.getAccount(req.params.accountId);
    if (!account) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
      return;
    }
    const campaigns = await orgService.listCampaignsByAccount(
      req.params.accountId,
    );
    res.status(200).json(campaigns);
  } catch (err) {
    next(err);
  }
}

export async function getCampaign(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const campaign = await orgService.getCampaign(req.params.id);
    if (!campaign) {
      res
        .status(404)
        .json({ code: 'NOT_FOUND', message: 'Campaign not found' });
      return;
    }
    res.status(200).json(campaign);
  } catch (err) {
    next(err);
  }
}

// ── Staff ──────────────────────────────────────────────────────────────────

export async function listStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // ?all=true includes former staff — omit for active + on_leave only
    const activeOnly = req.query['all'] !== 'true';
    const staff = await orgService.listStaff(activeOnly);
    res.status(200).json(staff);
  } catch (err) {
    next(err);
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
      res
        .status(404)
        .json({ code: 'NOT_FOUND', message: 'Staff member not found' });
      return;
    }
    res.status(200).json(member);
  } catch (err) {
    next(err);
  }
}
