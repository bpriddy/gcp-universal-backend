-- Account business fields.
-- These are the "write both" fields — state lives on the row, history is
-- logged to account_changes. The Drive sync module's allowlist points at these.
--
-- Adding a field later is: one ALTER TABLE here + one line in drive.schema.ts.

ALTER TABLE "accounts"
  ADD COLUMN "status"                 TEXT NULL,
  ADD COLUMN "account_exec_staff_id"  UUID NULL REFERENCES "staff"("id") ON DELETE SET NULL,
  ADD COLUMN "industry"               TEXT NULL,
  ADD COLUMN "primary_contact_name"   TEXT NULL,
  ADD COLUMN "primary_contact_email"  TEXT NULL,
  ADD COLUMN "notes"                  TEXT NULL,
  ADD CONSTRAINT "accounts_status_check"
    CHECK (status IS NULL OR status IN ('active', 'inactive', 'prospect'));

CREATE INDEX "accounts_status_idx"                ON "accounts"("status");
CREATE INDEX "accounts_account_exec_staff_id_idx" ON "accounts"("account_exec_staff_id");
