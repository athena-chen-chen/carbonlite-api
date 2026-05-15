-- Add a direct one-organization-per-user relation for MVP auth.
-- Existing users, if any, are attached to a fallback organization so the column can be required.
INSERT INTO "Organization" ("id", "name", "slug", "isActive", "createdAt", "updatedAt")
VALUES ('demo-org-id', 'Demo Organization', 'demo-org', true, NOW(), NOW())
ON CONFLICT ("slug") DO NOTHING;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

UPDATE "User"
SET "organizationId" = 'demo-org-id'
WHERE "organizationId" IS NULL;

ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "User_organizationId_idx" ON "User"("organizationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_organizationId_fkey'
  ) THEN
    ALTER TABLE "User"
    ADD CONSTRAINT "User_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
