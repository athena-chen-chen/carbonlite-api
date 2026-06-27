-- Factor Library v1.0 governed domain.
-- Existing ConversionFactor records remain in place for backward compatibility.

CREATE TYPE "FactorStatus" AS ENUM ('DRAFT', 'OFFICIAL', 'VERIFIED', 'DEPRECATED', 'ARCHIVED');
CREATE TYPE "FactorConfidenceLevel" AS ENUM ('OFFICIAL_GOVERNMENT', 'INDUSTRY_STANDARD', 'ESTIMATED', 'CUSTOM', 'DEMO');
CREATE TYPE "FactorCategory" AS ENUM ('FUEL', 'ELECTRICITY', 'NATURAL_GAS', 'WATER', 'WASTE', 'TRANSPORT', 'HOTEL', 'SHIPPING', 'OTHER');
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_UPDATE');

CREATE TABLE "Factor" (
  "id" TEXT NOT NULL,
  "activityType" "ActivityType" NOT NULL,
  "displayName" TEXT NOT NULL,
  "category" "FactorCategory" NOT NULL DEFAULT 'OTHER',
  "scope" TEXT,
  "description" TEXT,
  "isSystem" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Factor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactorSource" (
  "id" TEXT NOT NULL,
  "sourceAuthority" TEXT NOT NULL,
  "sourceDocument" TEXT,
  "sourceVersion" TEXT,
  "sourceYear" INTEGER,
  "sourceUrl" TEXT,
  "sourcePage" TEXT,
  "sourceTable" TEXT,
  "publishedDate" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactorSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactorVersion" (
  "id" TEXT NOT NULL,
  "factorId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "factorValue" DECIMAL(18,8) NOT NULL,
  "inputUnit" TEXT NOT NULL,
  "resultUnit" TEXT NOT NULL,
  "jurisdictionCountry" TEXT,
  "jurisdictionRegion" TEXT,
  "factorYear" INTEGER,
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "status" "FactorStatus" NOT NULL DEFAULT 'DRAFT',
  "confidenceLevel" "FactorConfidenceLevel" NOT NULL DEFAULT 'DEMO',
  "sourceId" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactorVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactorReviewLog" (
  "id" TEXT NOT NULL,
  "factorVersionId" TEXT NOT NULL,
  "reviewedBy" TEXT,
  "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
  "reviewNotes" TEXT,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactorReviewLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactorChangeLog" (
  "id" TEXT NOT NULL,
  "factorId" TEXT NOT NULL,
  "factorVersionId" TEXT,
  "action" TEXT NOT NULL,
  "oldValue" JSONB,
  "newValue" JSONB,
  "reason" TEXT,
  "changedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactorChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FactorVersion_factorId_version_key" ON "FactorVersion"("factorId", "version");
CREATE INDEX "Factor_activityType_idx" ON "Factor"("activityType");
CREATE INDEX "Factor_category_idx" ON "Factor"("category");
CREATE INDEX "Factor_isSystem_idx" ON "Factor"("isSystem");
CREATE INDEX "Factor_isActive_idx" ON "Factor"("isActive");
CREATE INDEX "FactorSource_sourceAuthority_idx" ON "FactorSource"("sourceAuthority");
CREATE INDEX "FactorSource_sourceYear_idx" ON "FactorSource"("sourceYear");
CREATE INDEX "FactorVersion_factorId_idx" ON "FactorVersion"("factorId");
CREATE INDEX "FactorVersion_inputUnit_idx" ON "FactorVersion"("inputUnit");
CREATE INDEX "FactorVersion_jurisdictionRegion_idx" ON "FactorVersion"("jurisdictionRegion");
CREATE INDEX "FactorVersion_factorYear_idx" ON "FactorVersion"("factorYear");
CREATE INDEX "FactorVersion_status_idx" ON "FactorVersion"("status");
CREATE INDEX "FactorVersion_factorId_version_idx" ON "FactorVersion"("factorId", "version");
CREATE INDEX "FactorReviewLog_factorVersionId_idx" ON "FactorReviewLog"("factorVersionId");
CREATE INDEX "FactorReviewLog_reviewedBy_idx" ON "FactorReviewLog"("reviewedBy");
CREATE INDEX "FactorReviewLog_reviewStatus_idx" ON "FactorReviewLog"("reviewStatus");
CREATE INDEX "FactorReviewLog_reviewedAt_idx" ON "FactorReviewLog"("reviewedAt");
CREATE INDEX "FactorChangeLog_factorId_idx" ON "FactorChangeLog"("factorId");
CREATE INDEX "FactorChangeLog_factorVersionId_idx" ON "FactorChangeLog"("factorVersionId");
CREATE INDEX "FactorChangeLog_action_idx" ON "FactorChangeLog"("action");
CREATE INDEX "FactorChangeLog_changedBy_idx" ON "FactorChangeLog"("changedBy");
CREATE INDEX "FactorChangeLog_createdAt_idx" ON "FactorChangeLog"("createdAt");

ALTER TABLE "FactorVersion" ADD CONSTRAINT "FactorVersion_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "Factor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactorVersion" ADD CONSTRAINT "FactorVersion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "FactorSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FactorReviewLog" ADD CONSTRAINT "FactorReviewLog_factorVersionId_fkey" FOREIGN KEY ("factorVersionId") REFERENCES "FactorVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactorReviewLog" ADD CONSTRAINT "FactorReviewLog_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FactorChangeLog" ADD CONSTRAINT "FactorChangeLog_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "Factor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactorChangeLog" ADD CONSTRAINT "FactorChangeLog_factorVersionId_fkey" FOREIGN KEY ("factorVersionId") REFERENCES "FactorVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FactorChangeLog" ADD CONSTRAINT "FactorChangeLog_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Mirror existing ConversionFactor rows into the new governed domain as demo draft factors.
INSERT INTO "FactorSource" (
  "id", "sourceAuthority", "sourceDocument", "sourceYear", "sourceUrl", "notes", "createdAt", "updatedAt"
)
SELECT DISTINCT
  'source_' || md5(coalesce("sourceAuthority", "sourceName", 'CarbonLite system defaults') || '|' || coalesce("sourceDocument", "sourceReference", 'Pilot demo factor library') || '|' || coalesce("sourceYear"::text, '')),
  coalesce("sourceAuthority", "sourceName", 'CarbonLite system defaults'),
  coalesce("sourceDocument", "sourceReference", 'Pilot demo factor library'),
  "sourceYear",
  "sourceUrl",
  coalesce("notes", 'Demo factor. Verify before client or regulatory reporting.'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ConversionFactor"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Factor" (
  "id", "activityType", "displayName", "category", "scope", "description", "isSystem", "isActive", "createdAt", "updatedAt"
)
SELECT
  'factor_' || md5(coalesce("activityType"::text, 'CUSTOM') || '|' || "name" || '|' || coalesce("unit", '')),
  coalesce("activityType", 'CUSTOM'::"ActivityType"),
  "name",
  CASE
    WHEN "activityType" IN ('DIESEL', 'GASOLINE') THEN 'FUEL'::"FactorCategory"
    WHEN "activityType" = 'NATURAL_GAS' THEN 'NATURAL_GAS'::"FactorCategory"
    WHEN "activityType" = 'ELECTRICITY' THEN 'ELECTRICITY'::"FactorCategory"
    WHEN "activityType" = 'WATER' THEN 'WATER'::"FactorCategory"
    WHEN "activityType" = 'WASTE' THEN 'WASTE'::"FactorCategory"
    WHEN "activityType" = 'AIR_TRAVEL' THEN 'TRANSPORT'::"FactorCategory"
    WHEN "activityType" = 'HOTEL' THEN 'HOTEL'::"FactorCategory"
    WHEN "activityType" = 'SHIPPING' THEN 'SHIPPING'::"FactorCategory"
    ELSE 'OTHER'::"FactorCategory"
  END,
  CASE
    WHEN "activityType" IN ('ELECTRICITY') THEN 'Scope 2'
    WHEN "activityType" IN ('DIESEL', 'GASOLINE', 'NATURAL_GAS') THEN 'Scope 1'
    ELSE NULL
  END,
  coalesce("methodology", "notes"),
  "isSystemDefault",
  true,
  "createdAt",
  "updatedAt"
FROM "ConversionFactor"
WHERE "activityType" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "FactorVersion" (
  "id", "factorId", "version", "factorValue", "inputUnit", "resultUnit",
  "jurisdictionCountry", "jurisdictionRegion", "factorYear", "effectiveFrom", "effectiveTo",
  "status", "confidenceLevel", "sourceId", "notes", "createdAt", "updatedAt"
)
SELECT
  'factor_version_' || md5("id"),
  'factor_' || md5(coalesce("activityType"::text, 'CUSTOM') || '|' || "name" || '|' || coalesce("unit", '')),
  'v1-' || substring(md5("id") from 1 for 8),
  "factorValue",
  "unit",
  "resultUnit",
  coalesce("country", CASE WHEN "jurisdiction" ILIKE '%Canada%' THEN 'Canada' ELSE NULL END),
  coalesce("region", "jurisdiction"),
  "sourceYear",
  "effectiveFrom",
  "effectiveTo",
  'DRAFT'::"FactorStatus",
  'DEMO'::"FactorConfidenceLevel",
  'source_' || md5(coalesce("sourceAuthority", "sourceName", 'CarbonLite system defaults') || '|' || coalesce("sourceDocument", "sourceReference", 'Pilot demo factor library') || '|' || coalesce("sourceYear"::text, '')),
  coalesce("notes", 'Demo factor. Verify before client or regulatory reporting.'),
  "createdAt",
  "updatedAt"
FROM "ConversionFactor"
WHERE "activityType" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "FactorChangeLog" (
  "id", "factorId", "factorVersionId", "action", "newValue", "reason", "createdAt"
)
SELECT
  'change_' || md5("id"),
  'factor_' || md5(coalesce("activityType"::text, 'CUSTOM') || '|' || "name" || '|' || coalesce("unit", '')),
  'factor_version_' || md5("id"),
  'MIGRATED_FROM_CONVERSION_FACTOR',
  jsonb_build_object(
    'conversionFactorId', "id",
    'name', "name",
    'activityType', "activityType",
    'unit', "unit",
    'factorValue', "factorValue",
    'resultUnit', "resultUnit"
  ),
  'Initial Factor Library v1.0 compatibility migration. Existing factors are demo draft factors until reviewed.',
  CURRENT_TIMESTAMP
FROM "ConversionFactor"
WHERE "activityType" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- Database-level safety: official/verified factor versions must be deprecated/archived, not deleted.
CREATE OR REPLACE FUNCTION prevent_official_factor_version_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('OFFICIAL', 'VERIFIED') THEN
    RAISE EXCEPTION 'Official or verified factor versions cannot be deleted. Deprecate or archive them instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FactorVersion_prevent_official_delete"
BEFORE DELETE ON "FactorVersion"
FOR EACH ROW
EXECUTE FUNCTION prevent_official_factor_version_delete();
