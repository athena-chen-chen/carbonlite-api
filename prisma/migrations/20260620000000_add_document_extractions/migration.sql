CREATE TABLE "DocumentExtraction" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "status" "DocumentStatus" NOT NULL,
  "extractedJson" JSONB NOT NULL,
  "extractedRows" JSONB NOT NULL,
  "sourceRowCount" INTEGER NOT NULL DEFAULT 0,
  "extractedRowCount" INTEGER NOT NULL DEFAULT 0,
  "possibleMissingRows" BOOLEAN NOT NULL DEFAULT false,
  "warning" TEXT,
  "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DocumentExtraction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentExtraction_documentId_key" ON "DocumentExtraction"("documentId");
CREATE INDEX "DocumentExtraction_organizationId_idx" ON "DocumentExtraction"("organizationId");
CREATE INDEX "DocumentExtraction_status_idx" ON "DocumentExtraction"("status");
CREATE INDEX "DocumentExtraction_extractedAt_idx" ON "DocumentExtraction"("extractedAt");

ALTER TABLE "DocumentExtraction"
  ADD CONSTRAINT "DocumentExtraction_organizationId_fkey"
  FOREIGN KEY ("organizationId")
  REFERENCES "Organization"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "DocumentExtraction"
  ADD CONSTRAINT "DocumentExtraction_documentId_fkey"
  FOREIGN KEY ("documentId")
  REFERENCES "Document"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
