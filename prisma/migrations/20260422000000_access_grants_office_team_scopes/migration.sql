-- Widen access_grants.resource_type CHECK to gate offices and teams.
--
-- Rationale: it's not always appropriate for the broader staff to be aware
-- of offices or teams that opened and closed quickly, or sensitive internal
-- teams. Bringing offices + teams under the access-grant system gives us a
-- uniform gate across org entities, mirroring the existing staff_* and
-- account/campaign patterns.
--
-- New resource types (all mirror the staff_* cohort shape):
--   • office          — per-office grant (resourceId = offices.id)
--   • office_all      — blanket grant over every office
--   • office_active   — grant over offices where is_active = true (default for broad staff)
--   • team            — per-team grant (resourceId = teams.id)
--   • team_all        — blanket grant over every team
--   • team_active     — grant over teams where is_active = true
--
-- Users with zero office/team grants will see empty /org/offices and
-- /org/teams responses — consistent with the existing staff behavior.
-- Admins continue to bypass the gate.
--
-- Mirror update required in access_requests_resource_type_check if the
-- admin surface adds request flows for offices/teams (not required today).

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
    'office',
    'office_all',
    'office_active',
    'team',
    'team_all',
    'team_active',
    'func:temporal',
    'func:export',
    'func:admin_ui'
  ]));
