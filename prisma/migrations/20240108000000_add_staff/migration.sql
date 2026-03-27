-- Staff table: org state tracking for employees.
-- NOT an auth table — that is handled by users.
-- A staff record exists independently of platform access.
-- user_id is nullable: not all staff will have a users account.

CREATE TABLE "staff" (
    "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID,
    "full_name"  TEXT        NOT NULL,
    "email"      TEXT        NOT NULL,
    "title"      TEXT,
    "department" TEXT,
    "status"     TEXT        NOT NULL DEFAULT 'active',
    "started_at" DATE        NOT NULL,
    "ended_at"   DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "staff_pkey"           PRIMARY KEY ("id"),
    CONSTRAINT "staff_email_key"      UNIQUE ("email"),
    CONSTRAINT "staff_user_id_fkey"   FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "staff_status_check"   CHECK ("status" IN ('active', 'on_leave', 'former'))
);

CREATE INDEX "staff_user_id_idx" ON "staff"("user_id");
CREATE INDEX "staff_status_idx"  ON "staff"("status");

-- Reuse the existing set_updated_at() function from migration 001
CREATE TRIGGER "set_staff_updated_at"
    BEFORE UPDATE ON "staff"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Block hard deletes — use status = 'former' + ended_at instead
CREATE OR REPLACE FUNCTION raise_staff_no_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Staff records cannot be deleted. Set status = ''former'' and populate ended_at instead.'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "staff_no_delete"
    BEFORE DELETE ON "staff"
    FOR EACH ROW EXECUTE FUNCTION raise_staff_no_delete();

-- External IDs: Maconomy employee ID, ADP, badge systems, etc.
-- Mirrors the shape of user_external_ids.
-- Adding a new system is a new row — no schema change required.
CREATE TABLE "staff_external_ids" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "staff_id"    UUID        NOT NULL,
    "system"      TEXT        NOT NULL,
    "external_id" TEXT        NOT NULL,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "staff_external_ids_pkey"            PRIMARY KEY ("id"),
    CONSTRAINT "staff_external_ids_system_ext_key"  UNIQUE ("system", "external_id"),
    CONSTRAINT "staff_external_ids_staff_id_fkey"   FOREIGN KEY ("staff_id")
        REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "staff_external_ids_staff_id_idx" ON "staff_external_ids"("staff_id");
