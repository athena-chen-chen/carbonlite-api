ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_actorUserId_fkey";
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_organizationId_fkey";

DROP INDEX IF EXISTS "AuditLog_actorUserId_idx";

ALTER TABLE "AuditLog"
  ADD COLUMN IF NOT EXISTS "userId" TEXT,
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "oldValue" JSONB,
  ADD COLUMN IF NOT EXISTS "newValue" JSONB,
  ADD COLUMN IF NOT EXISTS "page" TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

UPDATE "AuditLog"
SET
  "userId" = COALESCE("userId", "actorUserId"),
  "oldValue" = COALESCE("oldValue", "oldValues"),
  "newValue" = COALESCE("newValue", "newValues")
WHERE
  "actorUserId" IS NOT NULL
  OR "oldValues" IS NOT NULL
  OR "newValues" IS NOT NULL;

ALTER TABLE "AuditLog"
  ALTER COLUMN "organizationId" DROP NOT NULL,
  ALTER COLUMN "entityId" DROP NOT NULL;

ALTER TABLE "AuditLog"
  DROP COLUMN IF EXISTS "actorUserId",
  DROP COLUMN IF EXISTS "oldValues",
  DROP COLUMN IF EXISTS "newValues";

CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_idx" ON "AuditLog"("entityType");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_organizationId_fkey"
  FOREIGN KEY ("organizationId")
  REFERENCES "Organization"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
