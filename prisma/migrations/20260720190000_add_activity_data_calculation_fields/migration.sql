-- AlterTable
ALTER TABLE "ActivityData"
ADD COLUMN "matchingStatus" TEXT,
ADD COLUMN "reportTreatment" TEXT,
ADD COLUMN "scope" TEXT,
ADD COLUMN "matchedFactorId" TEXT,
ADD COLUMN "matchedFactorName" TEXT,
ADD COLUMN "matchedFactorSourceYear" INTEGER,
ADD COLUMN "calculatedEmissionsKgCO2e" DOUBLE PRECISION,
ADD COLUMN "calculationStatus" TEXT,
ADD COLUMN "calculationMessage" TEXT;
