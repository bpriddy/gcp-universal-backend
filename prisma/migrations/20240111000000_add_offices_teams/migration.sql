-- CreateTable: offices
CREATE TABLE "offices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "offices_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex: offices.name
CREATE UNIQUE INDEX "offices_name_key" ON "offices"("name");

-- CreateTable: teams
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex: teams.name
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

-- CreateTable: team_members
CREATE TABLE "team_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex: team_members unique per team+staff
CREATE UNIQUE INDEX "team_members_team_id_staff_id_key" ON "team_members"("team_id", "staff_id");

-- CreateIndex: team_members.staff_id
CREATE INDEX "team_members_staff_id_idx" ON "team_members"("staff_id");

-- AddColumn: staff.office_id
ALTER TABLE "staff" ADD COLUMN "office_id" UUID;

-- CreateIndex: staff.office_id
CREATE INDEX "staff_office_id_idx" ON "staff"("office_id");

-- AddForeignKey: staff.office_id -> offices.id
ALTER TABLE "staff" ADD CONSTRAINT "staff_office_id_fkey"
    FOREIGN KEY ("office_id") REFERENCES "offices"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: team_members.team_id -> teams.id
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: team_members.staff_id -> staff.id
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_staff_id_fkey"
    FOREIGN KEY ("staff_id") REFERENCES "staff"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
