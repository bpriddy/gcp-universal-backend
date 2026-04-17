-- Widen access_grants.resource_type CHECK to match the resource types the
-- application actually inserts. The original 2024-01-10 migration only allowed
-- 'account' and 'campaign', but several code paths have since added:
--   • Staff scopes used by org.service.ts listStaffVisibleToUser():
--       staff_all, staff_current, staff_office, staff_team
--   • Functional scopes used by access.service.ts / cascading-access.service.ts:
--       func:temporal, func:export, func:admin_ui
--
-- Without this, gub-admin's staff grant form (POST /api/grants/staff) hits the
-- check constraint and returns a 500 HTML error page — which then crashes the
-- form's res.json() handler. See also access_requests_resource_type_check
-- (added 2024-01-16), which already allows these values on the requests side.

ALTER TABLE "access_grants"
  DROP CONSTRAINT IF EXISTS "access_grants_resource_type_check";

ALTER TABLE "access_grants"
  ADD CONSTRAINT "access_grants_resource_type_check"
  CHECK (resource_type = ANY (ARRAY[
    'account',
    'campaign',
    'staff_all',
    'staff_current',
    'staff_office',
    'staff_team',
    'func:temporal',
    'func:export',
    'func:admin_ui'
  ]));
