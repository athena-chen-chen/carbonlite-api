-- CreateEnum
CREATE TYPE "SpreadsheetImportSourceType" AS ENUM ('CSV', 'EXCEL', 'PASTE');

-- CreateEnum
CREATE TYPE "SpreadsheetReviewRowStatus" AS ENUM ('READY', 'NEEDS_REVIEW', 'TRACKED_ONLY');

-- CreateTable
CREATE TABLE "SpreadsheetImportReviewRow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT,
    "rowId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SpreadsheetReviewRowStatus" NOT NULL,
    "sourceType" "SpreadsheetImportSourceType" NOT NULL,
    "sourceFileName" TEXT,
    "sourceSheetName" TEXT,
    "sourceRow" TEXT,
    "sourceReference" TEXT,
    "activityType" TEXT,
    "rawActivityType" TEXT,
    "recordDate" TIMESTAMP(3),
    "rawRecordDate" JSONB,
    "quantity" DECIMAL(18,4),
    "rawQuantity" TEXT,
    "unit" TEXT,
    "jurisdictionCountry" TEXT,
    "jurisdictionRegion" TEXT,
    "facilityName" TEXT,
    "notes" TEXT,
    "issues" JSONB NOT NULL,
    "rawSourceRow" JSONB,
    "matchingStatus" TEXT,
    "reportTreatment" TEXT,
    "scope" TEXT,
    "matchedFactorId" TEXT,
    "matchedFactorName" TEXT,
    "matchedFactorSourceYear" INTEGER,
    "matchedFactorValue" DOUBLE PRECISION,
    "matchedFactorUnit" TEXT,
    "matchedFactorVersion" TEXT,
    "matchedFactorSourceAuthority" TEXT,
    "matchedFactorSourceDocument" TEXT,
    "matchedFactorVerificationStatus" TEXT,
    "matchedFactorConfidenceLevel" TEXT,
    "matchedFactorAssumptions" TEXT,
    "calculatedEmissionsKgCO2e" DOUBLE PRECISION,
    "calculationStatus" TEXT,
    "calculationMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpreadsheetImportReviewRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpreadsheetImportReviewRow_idempotency_key" ON "SpreadsheetImportReviewRow"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SpreadsheetImportReviewRow_organizationId_idx" ON "SpreadsheetImportReviewRow"("organizationId");

-- CreateIndex
CREATE INDEX "SpreadsheetImportReviewRow_organizationId_status_idx" ON "SpreadsheetImportReviewRow"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SpreadsheetImportReviewRow_organizationId_sourceFileName_idx" ON "SpreadsheetImportReviewRow"("organizationId", "sourceFileName");

-- AddForeignKey
ALTER TABLE "SpreadsheetImportReviewRow" ADD CONSTRAINT "SpreadsheetImportReviewRow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
