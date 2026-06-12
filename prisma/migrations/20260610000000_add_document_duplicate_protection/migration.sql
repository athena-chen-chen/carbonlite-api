ALTER TYPE "DocumentStatus" ADD VALUE IF NOT EXISTS 'IMPORTED';

ALTER TABLE "Document"
ADD COLUMN "fileHash" TEXT,
ADD COLUMN "importedAt" TIMESTAMP(3),
ADD COLUMN "importBatchId" TEXT;

CREATE INDEX "Document_organizationId_fileHash_idx"
ON "Document"("organizationId", "fileHash");
