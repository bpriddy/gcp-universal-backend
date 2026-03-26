-- CreateTable: audit_log
CREATE TABLE "audit_log" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "action"      TEXT        NOT NULL,
    "entity_type" TEXT        NOT NULL,
    "entity_id"   UUID        NOT NULL,
    "actor_id"    UUID        NOT NULL,
    "before"      JSONB,
    "after"       JSONB,
    "metadata"    JSONB,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- Lookup by entity (e.g. full history of a campaign)
CREATE INDEX "audit_log_entity_idx"
    ON "audit_log"("entity_type", "entity_id", "created_at" DESC);

-- Lookup by actor (e.g. everything a user has done)
CREATE INDEX "audit_log_actor_idx"
    ON "audit_log"("actor_id", "created_at" DESC);

-- Lookup by action type (e.g. all status changes across all campaigns)
CREATE INDEX "audit_log_action_idx"
    ON "audit_log"("action", "created_at" DESC);

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Block updates — audit rows are immutable once written
CREATE OR REPLACE FUNCTION raise_audit_log_no_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log rows are immutable and cannot be updated.'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION raise_audit_log_no_update();

-- Block deletes — audit rows are immutable once written
CREATE OR REPLACE FUNCTION raise_audit_log_no_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log rows cannot be deleted.'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION raise_audit_log_no_delete();
