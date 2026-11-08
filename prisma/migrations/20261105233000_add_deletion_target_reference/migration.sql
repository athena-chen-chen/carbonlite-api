ALTER TABLE "DocumentDeletionIntent"
  ADD COLUMN "targetReferenceId" TEXT;

UPDATE "DocumentDeletionIntent"
SET "targetReferenceId" = COALESCE("documentId", "id")
WHERE "targetReferenceId" IS NULL;

ALTER TABLE "DocumentDeletionIntent"
  ALTER COLUMN "targetReferenceId" SET NOT NULL;

CREATE INDEX "DocumentDeletionIntent_organizationId_targetReferenceId_idx"
  ON "DocumentDeletionIntent"("organizationId", "targetReferenceId");
