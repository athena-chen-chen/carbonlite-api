-- Official source registry for governed factor library
CREATE TYPE "PublisherType" AS ENUM ('GOVERNMENT', 'INDUSTRY_BODY', 'STANDARD_BODY', 'COMPANY', 'CUSTOM', 'UNKNOWN');

ALTER TABLE "FactorSource"
  ADD COLUMN "sourceShortName" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "jurisdictionRegion" TEXT,
  ADD COLUMN "publisherType" "PublisherType" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "isOfficial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "FactorVersion"
  ADD COLUMN "sourcePage" TEXT,
  ADD COLUMN "sourceSection" TEXT,
  ADD COLUMN "sourceTable" TEXT,
  ADD COLUMN "sourceRow" TEXT,
  ADD COLUMN "sourceColumn" TEXT,
  ADD COLUMN "citationText" TEXT;

CREATE INDEX "FactorSource_sourceShortName_idx" ON "FactorSource"("sourceShortName");
CREATE INDEX "FactorSource_publisherType_idx" ON "FactorSource"("publisherType");
CREATE INDEX "FactorSource_isOfficial_idx" ON "FactorSource"("isOfficial");
CREATE INDEX "FactorSource_isActive_idx" ON "FactorSource"("isActive");
