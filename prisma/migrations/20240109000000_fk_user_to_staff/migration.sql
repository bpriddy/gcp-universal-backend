-- Re-point org relationship FKs from users → staff.
--
-- users is the auth identity layer.
-- staff is the source of truth for people in org relationships.
--
-- Column names are unchanged — only the referenced table changes.
-- Convention: when value_uuid in account_changes or campaign_changes
-- references a person, it stores a staff.id. Properties that do so
-- should be named with suffix _staff_id (e.g. account_exec_staff_id).

-- ── account_changes.changed_by ─────────────────────────────────────────────
ALTER TABLE "account_changes"
    DROP CONSTRAINT "account_changes_changed_by_fkey",
    ADD  CONSTRAINT "account_changes_changed_by_staff_fkey"
        FOREIGN KEY ("changed_by")
        REFERENCES "staff"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── campaign_changes.changed_by ────────────────────────────────────────────
ALTER TABLE "campaign_changes"
    DROP CONSTRAINT "campaign_changes_changed_by_fkey",
    ADD  CONSTRAINT "campaign_changes_changed_by_staff_fkey"
        FOREIGN KEY ("changed_by")
        REFERENCES "staff"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── campaigns.created_by ───────────────────────────────────────────────────
ALTER TABLE "campaigns"
    DROP CONSTRAINT "campaigns_created_by_fkey",
    ADD  CONSTRAINT "campaigns_created_by_staff_fkey"
        FOREIGN KEY ("created_by")
        REFERENCES "staff"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── audit_log.actor_id ─────────────────────────────────────────────────────
-- Note: audit_log has immutability triggers on UPDATE and DELETE rows,
-- but this is a DDL constraint change — triggers do not fire for DDL.
ALTER TABLE "audit_log"
    DROP CONSTRAINT "audit_log_actor_id_fkey",
    ADD  CONSTRAINT "audit_log_actor_id_staff_fkey"
        FOREIGN KEY ("actor_id")
        REFERENCES "staff"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
