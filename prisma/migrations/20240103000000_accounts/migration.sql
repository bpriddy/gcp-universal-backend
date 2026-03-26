-- CreateTable: accounts
CREATE TABLE "accounts" (
    "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
    "name"       TEXT        NOT NULL,
    "parent_id"  UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "accounts_parent_id_idx" ON "accounts"("parent_id");

ALTER TABLE "accounts"
    ADD CONSTRAINT "accounts_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER accounts_updated_at
    BEFORE UPDATE ON "accounts"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: account_changes
CREATE TABLE "account_changes" (
    "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID        NOT NULL,
    "property"   TEXT        NOT NULL,
    "value_text" TEXT,
    "value_uuid" UUID,
    "value_date" DATE,
    "changed_by" UUID        NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "account_changes_pkey" PRIMARY KEY ("id")
);

-- Fast current-state query: latest value per property for an account
CREATE INDEX "account_changes_account_id_property_idx"
    ON "account_changes"("account_id", "property", "changed_at" DESC);

ALTER TABLE "account_changes"
    ADD CONSTRAINT "account_changes_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_changes"
    ADD CONSTRAINT "account_changes_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
