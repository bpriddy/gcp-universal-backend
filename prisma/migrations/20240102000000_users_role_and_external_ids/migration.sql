-- Add role and is_admin to users
ALTER TABLE "users"
  ADD COLUMN "role"     TEXT    NOT NULL DEFAULT 'viewer',
  ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT FALSE;

-- Constrain role to known values
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_check"
  CHECK ("role" IN ('admin', 'manager', 'contributor', 'viewer'));

-- CreateTable: user_external_ids
CREATE TABLE "user_external_ids" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"     UUID        NOT NULL,
    "system"      TEXT        NOT NULL,
    "external_id" TEXT        NOT NULL,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "user_external_ids_pkey" PRIMARY KEY ("id")
);

-- A given external ID can only belong to one user per system
CREATE UNIQUE INDEX "user_external_ids_system_external_id_key"
    ON "user_external_ids"("system", "external_id");

-- Fast lookup of all external IDs for a user
CREATE INDEX "user_external_ids_user_id_idx"
    ON "user_external_ids"("user_id");

ALTER TABLE "user_external_ids"
    ADD CONSTRAINT "user_external_ids_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
