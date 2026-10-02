-- AlterTable
ALTER TABLE "SpreadsheetImportReviewRow" ADD COLUMN "sourceDocumentId" TEXT;

-- CreateIndex
CREATE INDEX "SpreadsheetImportReviewRow_sourceDocumentId_idx" ON "SpreadsheetImportReviewRow"("sourceDocumentId");

-- AddForeignKey
ALTER TABLE "SpreadsheetImportReviewRow" ADD CONSTRAINT "SpreadsheetImportReviewRow_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
