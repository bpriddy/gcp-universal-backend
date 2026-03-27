import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as orgController from './org.controller';

const router = Router();

// All org routes require a valid JWT — no public access
router.use(authenticate);

// ── Accounts ───────────────────────────────────────────────────────────────

/**
 * GET /org/accounts
 * List all accounts with their current state resolved from account_changes.
 */
router.get('/accounts', orgController.listAccounts);

/**
 * GET /org/accounts/:id
 * Fetch a single account with current state.
 */
router.get('/accounts/:id', orgController.getAccount);

/**
 * GET /org/accounts/:accountId/campaigns
 * List all campaigns belonging to an account.
 */
router.get(
  '/accounts/:accountId/campaigns',
  orgController.listCampaignsByAccount,
);

// ── Campaigns ──────────────────────────────────────────────────────────────

/**
 * GET /org/campaigns/:id
 * Fetch a single campaign by ID.
 */
router.get('/campaigns/:id', orgController.getCampaign);

// ── Staff ──────────────────────────────────────────────────────────────────

/**
 * GET /org/staff
 * List staff members. Active + on_leave by default.
 * Pass ?all=true to include former staff.
 */
router.get('/staff', orgController.listStaff);

/**
 * GET /org/staff/:id
 * Fetch a single staff member by ID.
 */
router.get('/staff/:id', orgController.getStaffMember);

export default router;
