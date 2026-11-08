-- Recovery records intentionally do not reference tenant rows: they must
-- survive document and organization erasure until manual purge is verified.
CREATE TYPE "DocumentDeletionIntentStatus" AS ENUM (
  'PREPARED',
  'PENDING_PURGE',
  'PURGED',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE "DocumentDeletionTargetType" AS ENUM ('DOCUMENT', 'REPORT_ARTIFACT');

CREATE TABLE "DocumentDeletionIntent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "organizationIdHash" TEXT NOT NULL,
  "documentId" TEXT,
  "targetType" "DocumentDeletionTargetType" NOT NULL,
  "storageKey" TEXT NOT NULL,
  "quarantineKey" TEXT NOT NULL,
  "status" "DocumentDeletionIntentStatus" NOT NULL DEFAULT 'PREPARED',
  "operation" TEXT NOT NULL,
  "requestedById" TEXT,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "databaseDeletedAt" TIMESTAMP(3),
  "purgedAt" TIMESTAMP(3),
  "reconciliationCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentDeletionIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentDeletionPurgeReview" (
  "id" TEXT NOT NULL,
  "organizationIdHash" TEXT NOT NULL,
  "candidateIds" JSONB NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "reviewedById" TEXT NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedById" TEXT,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "DocumentDeletionPurgeReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentDeletionIntent_organizationId_storageKey_key"
  ON "DocumentDeletionIntent"("organizationId", "storageKey");
CREATE INDEX "DocumentDeletionIntent_organizationId_documentId_idx"
  ON "DocumentDeletionIntent"("organizationId", "documentId");
CREATE INDEX "DocumentDeletionIntent_status_preparedAt_idx"
  ON "DocumentDeletionIntent"("status", "preparedAt");
CREATE UNIQUE INDEX "DocumentDeletionPurgeReview_tokenHash_key"
  ON "DocumentDeletionPurgeReview"("tokenHash");
CREATE INDEX "DocumentDeletionPurgeReview_organizationIdHash_reviewedAt_idx"
  ON "DocumentDeletionPurgeReview"("organizationIdHash", "reviewedAt");

-- Preserve document-specific hold mappings after logical document deletion so
-- a pending quarantined copy remains protected from manual purge.
ALTER TABLE "LegalHoldDocument"
  DROP CONSTRAINT "LegalHoldDocument_documentId_fkey";
