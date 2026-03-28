-- Fully explicit per-resource access control.
--
-- Every user needs a row per resource they can access.
-- No implicit inheritance — granting account access does NOT grant campaign access.
-- The grantAccountAccess() helper in access.service.ts creates all rows in one
-- transactional call, hiding the row-level granularity from the editor UX.
--
-- Soft revoke only: set revoked_at + revoked_by. Never hard-delete.
-- This preserves the full audit trail of who had access to what and when.
--
-- is_admin on users bypasses all access checks — superuser escape hatch.

CREATE TABLE "access_grants" (
    "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"       UUID        NOT NULL,
    "resource_type" TEXT        NOT NULL,
    "resource_id"   UUID        NOT NULL,
    "role"          TEXT        NOT NULL DEFAULT 'viewer',
    "granted_by"    UUID        NOT NULL,
    "granted_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expires_at"    TIMESTAMPTZ,
    "revoked_at"    TIMESTAMPTZ,
    "revoked_by"    UUID,

    CONSTRAINT "access_grants_pkey"
        PRIMARY KEY ("id"),
    CONSTRAINT "access_grants_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "access_grants_granted_by_fkey"
        FOREIGN KEY ("granted_by") REFERENCES "staff"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "access_grants_revoked_by_fkey"
        FOREIGN KEY ("revoked_by") REFERENCES "staff"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "access_grants_resource_type_check"
        CHECK ("resource_type" IN ('account', 'campaign')),
    CONSTRAINT "access_grants_role_check"
        CHECK ("role" IN ('viewer', 'contributor', 'manager', 'admin')),
    -- Enforce that revoked_at and revoked_by are always set or unset together
    CONSTRAINT "access_grants_revoke_consistency_check"
        CHECK (
            ("revoked_at" IS NULL AND "revoked_by" IS NULL)
            OR
            ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
        )
);

-- Primary access check: "does this user have an active grant on this resource?"
-- Filtered to active grants only — keeps the index small and fast.
CREATE INDEX "access_grants_user_resource_active_idx"
    ON "access_grants"("user_id", "resource_type", "resource_id")
    WHERE "revoked_at" IS NULL;

-- One active grant per (user, resource_type, resource_id).
-- Allows multiple revoked rows for the same triple — full audit history preserved.
-- This is a partial unique index — Prisma cannot express this; it lives here only.
CREATE UNIQUE INDEX "access_grants_active_unique_idx"
    ON "access_grants"("user_id", "resource_type", "resource_id")
    WHERE "revoked_at" IS NULL;

-- "All grants for a user" — admin UI, profile page
CREATE INDEX "access_grants_user_id_idx"
    ON "access_grants"("user_id");

-- "Who has access to this resource?" — resource detail page
CREATE INDEX "access_grants_resource_idx"
    ON "access_grants"("resource_type", "resource_id")
    WHERE "revoked_at" IS NULL;

-- "Who granted what?" — audit queries
CREATE INDEX "access_grants_granted_by_idx"
    ON "access_grants"("granted_by");
