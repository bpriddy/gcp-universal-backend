-- Access requests: users submit these when they believe they should have
-- access to a resource or functional capability they currently cannot see.
-- Admins review in gub-admin: approve (creates a grant) or deny (with note).

CREATE TABLE access_requests (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Same domain as access_grants.resource_type
  resource_type        TEXT        NOT NULL,
  -- NULL for functional / scope grants (func:*, staff:*)
  resource_id          UUID,

  -- Role or capability level requested (viewer, contributor, rolling_1yr, etc.)
  requested_role       TEXT        NOT NULL,

  -- Optional free-text from the requester
  reason               TEXT,

  -- pending | approved | denied
  status               TEXT        NOT NULL DEFAULT 'pending',

  reviewed_by_staff_id UUID        REFERENCES staff(id) ON DELETE SET NULL,
  reviewed_at          TIMESTAMPTZ,
  review_note          TEXT,

  -- Populated on approval — UUID of the access_grants row that was created
  grant_id             UUID,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX access_requests_user_id_idx
  ON access_requests (user_id);

CREATE INDEX access_requests_status_idx
  ON access_requests (status)
  WHERE status = 'pending';

CREATE INDEX access_requests_resource_idx
  ON access_requests (resource_type, resource_id);
