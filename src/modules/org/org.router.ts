import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { setUserContext } from '../../middleware/setUserContext';
import * as orgController from './org.controller';

const router = Router();

// All org routes require a valid JWT — no public access
router.use(authenticate);

// Populate AsyncLocalStorage with the verified user identity so the Prisma
// $extends middleware can inject app.current_user_id for RLS enforcement.
router.use(setUserContext);

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

/**
 * GET /org/accounts/:id/history
 * Full change log for an account. Requires func:temporal grant (rolling or all_time).
 */
router.get('/accounts/:id/history', orgController.getAccountHistory);

// ── Campaigns ──────────────────────────────────────────────────────────────

/**
 * GET /org/campaigns
 * List all campaigns the caller can see across accounts. Optional
 * `?status=<status>` query filter. Admins see everything; other users
 * see campaigns they have an access_grant for (cascading grants from
 * account-level access are pre-materialized at grant time).
 */
router.get('/campaigns', orgController.listCampaigns);

/**
 * GET /org/campaigns/:id
 * Fetch a single campaign by ID.
 */
router.get('/campaigns/:id', orgController.getCampaign);

/**
 * GET /org/campaigns/:id/history
 * Full change log for a campaign. Requires func:temporal grant (rolling or all_time).
 */
router.get('/campaigns/:id/history', orgController.getCampaignHistory);

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

// ── Access requests ────────────────────────────────────────────────────────

/**
 * POST /org/access-requests
 * Submit a new access request. Any authenticated user can call this.
 * Body: { resourceType, resourceId?, requestedRole, reason? }
 */
router.post('/access-requests', orgController.createAccessRequest);

/**
 * GET /org/access-requests
 * List the calling user's own access requests (most recent first).
 */
router.get('/access-requests', orgController.listMyAccessRequests);

// ── App access requests ────────────────────────────────────────────────────

/**
 * POST /org/app-access-requests
 * Submit a request to access a gated app.
 * Body: { appId, reason? }
 * Returns 201 with the request (or existing pending request).
 * Returns 409 if the user already has an approved UserAppPermission.
 */
router.post('/app-access-requests', orgController.createAppAccessRequest);

/**
 * GET /org/app-access-requests
 * List the calling user's own app access requests (most recent first).
 */
router.get('/app-access-requests', orgController.listMyAppAccessRequests);

// ── Staff metadata ─────────────────────────────────────────────────────────

/**
 * GET /org/staff/:staffId/metadata
 * List all metadata for a staff member. Optional ?type= filter.
 */
router.get('/staff/:staffId/metadata', orgController.listStaffMetadata);

/**
 * POST /org/staff/:staffId/metadata
 * Create a metadata entry (skill, interest, work_highlight, etc.).
 */
router.post('/staff/:staffId/metadata', orgController.createStaffMetadata);

/**
 * PATCH /org/staff/:staffId/metadata/:id
 * Update a metadata entry.
 */
router.patch('/staff/:staffId/metadata/:id', orgController.updateStaffMetadata);

/**
 * DELETE /org/staff/:staffId/metadata/:id
 * Hard-delete a metadata entry. Recorded in audit_log.
 */
router.delete('/staff/:staffId/metadata/:id', orgController.deleteStaffMetadata);

/**
 * GET /org/resourcing
 * Cross-staff search by metadata type + optional filters.
 * Required: ?type=skill
 * Optional: ?label=video&value=expert&featured=true
 */
router.get('/resourcing', orgController.searchByMetadata);

export default router;
