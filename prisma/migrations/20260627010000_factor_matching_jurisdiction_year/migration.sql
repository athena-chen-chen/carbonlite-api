-- Province/year-aware factor matching settings and activity record jurisdiction overrides
ALTER TABLE "Organization"
  ADD COLUMN "defaultReportingYear" INTEGER,
  ADD COLUMN "allowDemoFactorsForCalculations" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ActivityData"
  ADD COLUMN "jurisdictionCountry" TEXT,
  ADD COLUMN "jurisdictionRegion" TEXT,
  ADD COLUMN "recordYear" INTEGER;

CREATE INDEX "ActivityData_jurisdictionCountry_idx" ON "ActivityData"("jurisdictionCountry");
CREATE INDEX "ActivityData_jurisdictionRegion_idx" ON "ActivityData"("jurisdictionRegion");
CREATE INDEX "ActivityData_recordYear_idx" ON "ActivityData"("recordYear");
