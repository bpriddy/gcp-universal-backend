-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable: users
CREATE TABLE "users" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "email"        TEXT         NOT NULL,
    "google_sub"   TEXT         NOT NULL,
    "display_name" TEXT,
    "avatar_url"   TEXT,
    "is_active"    BOOLEAN      NOT NULL DEFAULT TRUE,
    "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable: user_app_permissions
CREATE TABLE "user_app_permissions" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"       UUID         NOT NULL,
    "app_id"        TEXT         NOT NULL,
    "db_identifier" TEXT         NOT NULL,
    "role"          TEXT         NOT NULL DEFAULT 'viewer',
    "granted_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "granted_by"    UUID,

    CONSTRAINT "user_app_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: refresh_tokens
CREATE TABLE "refresh_tokens" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"      UUID         NOT NULL,
    "token_hash"   TEXT         NOT NULL,
    "family"       UUID         NOT NULL,
    "issued_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "expires_at"   TIMESTAMPTZ  NOT NULL,
    "revoked_at"   TIMESTAMPTZ,
    "replaced_by"  UUID,
    "ip_address"   TEXT,
    "user_agent"   TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key"      ON "users"("email");
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

CREATE UNIQUE INDEX "user_app_permissions_user_id_app_id_key"
    ON "user_app_permissions"("user_id", "app_id");

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE        INDEX "refresh_tokens_user_id_idx"    ON "refresh_tokens"("user_id");
CREATE        INDEX "refresh_tokens_family_idx"     ON "refresh_tokens"("family");

-- AddForeignKey
ALTER TABLE "user_app_permissions"
    ADD CONSTRAINT "user_app_permissions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_app_permissions"
    ADD CONSTRAINT "user_app_permissions_granted_by_fkey"
    FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
