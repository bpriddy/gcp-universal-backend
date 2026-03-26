-- Block all application-layer deletes on users.
-- Users may only be deleted via direct database access (superuser or migration).
-- Use is_active = false to deactivate a user instead.

CREATE OR REPLACE RULE "users_no_delete" AS
    ON DELETE TO "users"
    DO INSTEAD NOTHING;
