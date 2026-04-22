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

export async function getAccountHistory(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const history = await orgService.getAccountHistory(req.params.id, userId, isAdmin);
    res.status(200).json(history);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Campaigns ──────────────────────────────────────────────────────────────

/**
 * GET /org/campaigns
 * List all campaigns the caller can see across accounts. Optional
 * `?status=<status>` query filter.
 */
export async function listCampaigns(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const campaigns = await orgService.listCampaigns(userId, isAdmin, status);
    res.status(200).json(campaigns);
  } catch (err) {
    handleError(err, res, next);
  }
}

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

export async function getCampaignHistory(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const history = await orgService.getCampaignHistory(req.params.id, userId, isAdmin);
    res.status(200).json(history);
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

// ── Access requests ────────────────────────────────────────────────────────

export async function createAccessRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const parsed = orgService.CreateAccessRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'VALIDATION_ERROR', error: parsed.error.flatten() });
      return;
    }
    const request = await orgService.createAccessRequest(userId, parsed.data);
    res.status(201).json(request);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function listMyAccessRequests(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const requests = await orgService.listMyAccessRequests(userId);
    res.status(200).json(requests);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── App access requests ────────────────────────────────────────────────────

export async function createAppAccessRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const parsed = orgService.CreateAppAccessRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'VALIDATION_ERROR', error: parsed.error.flatten() });
      return;
    }
    const request = await orgService.createAppAccessRequest(userId, parsed.data);
    res.status(201).json(request);
  } catch (err) {
    // Surface the already-granted 409 cleanly
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code === 'ALREADY_GRANTED') {
      res.status(409).json({ code: 'ALREADY_GRANTED', message: e.message });
      return;
    }
    handleError(err, res, next);
  }
}

export async function listMyAppAccessRequests(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const requests = await orgService.listMyAppAccessRequests(userId);
    res.status(200).json(requests);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Staff metadata ─────────────────────────────────────────────────────────

export async function listStaffMetadata(
  req: Request<{ staffId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const type = typeof req.query['type'] === 'string' ? req.query['type'] : undefined;
    const rows = await orgService.listStaffMetadata(req.params.staffId, type);
    res.status(200).json(rows);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function createStaffMetadata(
  req: Request<{ staffId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const parsed = orgService.CreateStaffMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'VALIDATION_ERROR', error: parsed.error.flatten() });
      return;
    }
    const row = await orgService.createStaffMetadata(req.params.staffId, parsed.data, userId);
    res.status(201).json(row);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function updateStaffMetadata(
  req: Request<{ staffId: string; id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const parsed = orgService.UpdateStaffMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'VALIDATION_ERROR', error: parsed.error.flatten() });
      return;
    }
    const row = await orgService.updateStaffMetadata(req.params.id, req.params.staffId, parsed.data, userId);
    if (!row) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Metadata entry not found' });
      return;
    }
    res.status(200).json(row);
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function deleteStaffMetadata(
  req: Request<{ staffId: string; id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = identity(req);
    const deleted = await orgService.deleteStaffMetadata(req.params.id, req.params.staffId, userId);
    if (!deleted) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Metadata entry not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function searchByMetadata(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const type = typeof req.query['type'] === 'string' ? req.query['type'] : undefined;
    if (!type) {
      res.status(400).json({ code: 'VALIDATION_ERROR', message: '?type= is required' });
      return;
    }
    const label      = typeof req.query['label'] === 'string' ? req.query['label'] : undefined;
    const value      = typeof req.query['value'] === 'string' ? req.query['value'] : undefined;
    const isFeatured = req.query['featured'] === 'true' ? true : req.query['featured'] === 'false' ? false : undefined;
    const results = await orgService.searchByMetadata({
      type,
      ...(label      !== undefined ? { label }      : {}),
      ...(value      !== undefined ? { value }      : {}),
      ...(isFeatured !== undefined ? { isFeatured } : {}),
    });
    res.status(200).json(results);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Offices ────────────────────────────────────────────────────────────────

/**
 * GET /org/offices
 * List all offices. Optional `?activeOnly=true` filters to isActive=true.
 */
export async function listOffices(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const activeOnly = req.query['activeOnly'] === 'true';
    const offices = await orgService.listOffices(userId, isAdmin, activeOnly);
    res.status(200).json(offices);
  } catch (err) {
    handleError(err, res, next);
  }
}

/**
 * GET /org/offices/:id
 * Fetch a single office by id.
 */
export async function getOffice(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const office = await orgService.getOffice(req.params.id, userId, isAdmin);
    if (!office) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Office not found' });
      return;
    }
    res.status(200).json(office);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Teams ──────────────────────────────────────────────────────────────────

/**
 * GET /org/teams
 * List all teams with members. Optional `?activeOnly=true` filters to isActive=true.
 */
export async function listTeams(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const activeOnly = req.query['activeOnly'] === 'true';
    const teams = await orgService.listTeams(userId, isAdmin, activeOnly);
    res.status(200).json(teams);
  } catch (err) {
    handleError(err, res, next);
  }
}

/**
 * GET /org/teams/:id
 * Fetch a single team with members by id.
 */
export async function getTeam(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const team = await orgService.getTeam(req.params.id, userId, isAdmin);
    if (!team) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
      return;
    }
    res.status(200).json(team);
  } catch (err) {
    handleError(err, res, next);
  }
}

// ── Users ──────────────────────────────────────────────────────────────────

/**
 * GET /org/users
 * Admin-only. List all users. Optional `?activeOnly=true`.
 */
export async function listUsers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const activeOnly = req.query['activeOnly'] === 'true';
    const users = await orgService.listUsers(userId, isAdmin, activeOnly);
    res.status(200).json(users);
  } catch (err) {
    handleError(err, res, next);
  }
}

/**
 * GET /org/users/:id
 * Admin can fetch any user; non-admin users can only fetch themselves.
 */
export async function getUser(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, isAdmin } = identity(req);
    const user = await orgService.getUser(req.params.id, userId, isAdmin);
    if (!user) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
      return;
    }
    res.status(200).json(user);
  } catch (err) {
    handleError(err, res, next);
  }
}
