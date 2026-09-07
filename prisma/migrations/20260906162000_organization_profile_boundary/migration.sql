ALTER TABLE "Organization"
ADD COLUMN "otherIndustry" TEXT,
ADD COLUMN "city" TEXT,
ADD COLUMN "primaryContactName" TEXT,
ADD COLUMN "primaryContactEmail" TEXT,
ADD COLUMN "reportingPeriodStart" TEXT,
ADD COLUMN "reportingPeriodEnd" TEXT,
ADD COLUMN "geographicBoundary" TEXT,
ADD COLUMN "includedFacilitiesOrLocations" TEXT,
ADD COLUMN "excludedFacilitiesOrLocations" TEXT,
ADD COLUMN "includedScopes" TEXT,
ADD COLUMN "scope3CoverageNote" TEXT,
ADD COLUMN "exclusionsAndLimitations" TEXT,
ADD COLUMN "boundaryNotes" TEXT;
