-- Factor governance metadata and lifecycle constraints.

ALTER TABLE "FactorVersion"
  ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewedBy" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNotes" TEXT,
  ADD COLUMN "approvalSource" TEXT;

ALTER TABLE "FactorSource"
  ADD COLUMN "page" TEXT,
  ADD COLUMN "tableReference" TEXT;

UPDATE "FactorSource"
SET
  "sourceDocument" = COALESCE("sourceDocument", 'Pilot demo factor library'),
  "sourceVersion" = COALESCE("sourceVersion", ''),
  "sourceYear" = COALESCE("sourceYear", 0),
  "sourceUrl" = COALESCE("sourceUrl", ''),
  "page" = COALESCE("page", "sourcePage", ''),
  "tableReference" = COALESCE("tableReference", "sourceTable", ''),
  "publishedDate" = COALESCE("publishedDate", "createdAt", CURRENT_TIMESTAMP),
  "notes" = COALESCE("notes", 'Source metadata requires review.');

INSERT INTO "FactorSource" (
  "id", "sourceAuthority", "sourceDocument", "sourceVersion", "sourceYear", "sourceUrl",
  "page", "tableReference", "publishedDate", "notes", "createdAt", "updatedAt"
)
SELECT
  'source_missing_default',
  'CarbonLite system defaults',
  'Pilot demo factor library',
  '',
  0,
  '',
  '',
  '',
  CURRENT_TIMESTAMP,
  'Fallback source for migrated factor versions that were missing a source reference.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "FactorSource" WHERE "id" = 'source_missing_default');

UPDATE "FactorVersion"
SET "sourceId" = 'source_missing_default'
WHERE "sourceId" IS NULL;

ALTER TABLE "FactorVersion" DROP CONSTRAINT IF EXISTS "FactorVersion_sourceId_fkey";
ALTER TABLE "FactorVersion" ALTER COLUMN "sourceId" SET NOT NULL;

ALTER TABLE "FactorSource" ALTER COLUMN "sourceDocument" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "sourceVersion" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "sourceYear" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "sourceUrl" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "page" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "tableReference" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "publishedDate" SET NOT NULL;
ALTER TABLE "FactorSource" ALTER COLUMN "notes" SET NOT NULL;

ALTER TABLE "FactorVersion"
  ADD CONSTRAINT "FactorVersion_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "FactorSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "FactorVersion_confidenceLevel_idx" ON "FactorVersion"("confidenceLevel");
CREATE INDEX "FactorVersion_verified_idx" ON "FactorVersion"("verified");

-- Only one production-active version can exist for the same factor/unit/jurisdiction/year.
CREATE UNIQUE INDEX "FactorVersion_one_active_production_version_idx"
ON "FactorVersion"(
  "factorId",
  "inputUnit",
  COALESCE("jurisdictionCountry", ''),
  COALESCE("jurisdictionRegion", ''),
  COALESCE("factorYear", 0)
)
WHERE "status" IN ('OFFICIAL', 'VERIFIED');
