-- CreateTable: campaigns
CREATE TABLE "campaigns" (
    "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
    "account_id"  UUID           NOT NULL,
    "name"        TEXT           NOT NULL,
    "status"      TEXT           NOT NULL DEFAULT 'pitch',
    "budget"      NUMERIC(15, 2),
    "assets_url"  TEXT,
    "awarded_at"  DATE,
    "live_at"     DATE,
    "ends_at"     DATE,
    "created_by"  UUID           NOT NULL,
    "created_at"  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    "updated_at"  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaigns_account_id_idx" ON "campaigns"("account_id");
CREATE INDEX "campaigns_status_idx"     ON "campaigns"("status");
CREATE INDEX "campaigns_created_by_idx" ON "campaigns"("created_by");

ALTER TABLE "campaigns"
    ADD CONSTRAINT "campaigns_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaigns"
    ADD CONSTRAINT "campaigns_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER campaigns_updated_at
    BEFORE UPDATE ON "campaigns"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: campaign_changes
CREATE TABLE "campaign_changes" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID        NOT NULL,
    "property"    TEXT        NOT NULL,
    "value_text"  TEXT,
    "value_uuid"  UUID,
    "value_date"  DATE,
    "changed_by"  UUID        NOT NULL,
    "changed_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "campaign_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaign_changes_campaign_id_property_idx"
    ON "campaign_changes"("campaign_id", "property", "changed_at" DESC);

ALTER TABLE "campaign_changes"
    ADD CONSTRAINT "campaign_changes_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_changes"
    ADD CONSTRAINT "campaign_changes_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
