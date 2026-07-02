ALTER TABLE "ConversionFactor"
ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT;

ALTER TABLE "FactorVersion"
ADD COLUMN IF NOT EXISTS "methodology" TEXT,
ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT;

UPDATE "ConversionFactor"
SET
  "jurisdiction" = CASE
    WHEN "activityType" = 'ELECTRICITY' THEN 'Province Required'
    ELSE 'Canada (Generic)'
  END,
  "country" = COALESCE("country", 'Canada'),
  "sourceAuthority" = CASE
    WHEN "activityType" = 'WATER' THEN 'CarbonLite Pilot Methodology'
    ELSE 'CarbonLite System Defaults'
  END,
  "sourceName" = CASE
    WHEN "activityType" = 'WATER' THEN 'CarbonLite Pilot Methodology'
    ELSE 'CarbonLite System Defaults'
  END,
  "sourceDocument" = CASE
    WHEN "activityType" = 'WATER' THEN 'Water Emissions Placeholder Factor'
    ELSE 'CarbonLite MVP Default Factors v1.0'
  END,
  "sourceReference" = CASE
    WHEN "activityType" = 'WATER' THEN 'Water Emissions Placeholder Factor'
    ELSE 'CarbonLite MVP Default Factors v1.0'
  END,
  "sourceYear" = 2025,
  "sourceUrl" = CASE
    WHEN "activityType" = 'WATER' THEN 'https://carbonlite.ai/methodology/water-emissions'
    ELSE 'https://carbonlite.ai/methodology/default-factors'
  END,
  "confidenceLevel" = CASE
    WHEN "activityType" = 'ELECTRICITY' THEN 'Low (Placeholder)'
    WHEN "activityType" = 'WATER' THEN 'Pilot Estimate'
    ELSE 'Medium (Engineering Estimate)'
  END,
  "verificationStatus" = 'Internal Review Required',
  "verified" = false,
  "methodology" = CASE
    WHEN "activityType" = 'ELECTRICITY' THEN 'Electricity emission factors vary by province. Replace with official provincial electricity factors before production use.'
    WHEN "activityType" = 'WATER' THEN 'Estimated indirect emissions associated with municipal water treatment and distribution. Used for pilot workflow validation only.'
    ELSE 'Used for pilot validation. Intended for demonstration workflows only. Replace with official ECCC or provincial emission factors before production reporting.'
  END,
  "notes" = CASE
    WHEN "activityType" = 'ELECTRICITY' THEN 'Placeholder electricity factor for pilot testing only.'
    WHEN "activityType" = 'WATER' THEN 'Tracked metric with optional estimated emissions. Not intended for regulatory reporting.'
    ELSE 'Default system factor included with CarbonLite MVP. Not intended for regulatory reporting.'
  END
WHERE "isSystemDefault" = true;

UPDATE "FactorSource"
SET
  "sourceAuthority" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "FactorVersion" fv
      JOIN "Factor" f ON f."id" = fv."factorId"
      WHERE fv."sourceId" = "FactorSource"."id"
        AND f."activityType" = 'WATER'
    ) THEN 'CarbonLite Pilot Methodology'
    ELSE 'CarbonLite System Defaults'
  END,
  "sourceShortName" = 'CarbonLite',
  "sourceDocument" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "FactorVersion" fv
      JOIN "Factor" f ON f."id" = fv."factorId"
      WHERE fv."sourceId" = "FactorSource"."id"
        AND f."activityType" = 'WATER'
    ) THEN 'Water Emissions Placeholder Factor'
    ELSE 'CarbonLite MVP Default Factors v1.0'
  END,
  "sourceVersion" = 'v1.0',
  "sourceYear" = 2025,
  "sourceUrl" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "FactorVersion" fv
      JOIN "Factor" f ON f."id" = fv."factorId"
      WHERE fv."sourceId" = "FactorSource"."id"
        AND f."activityType" = 'WATER'
    ) THEN 'https://carbonlite.ai/methodology/water-emissions'
    ELSE 'https://carbonlite.ai/methodology/default-factors'
  END,
  "country" = 'Canada',
  "jurisdictionRegion" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "FactorVersion" fv
      JOIN "Factor" f ON f."id" = fv."factorId"
      WHERE fv."sourceId" = "FactorSource"."id"
        AND f."activityType" = 'ELECTRICITY'
    ) THEN 'Province Required'
    ELSE 'Canada (Generic)'
  END,
  "publisherType" = 'CUSTOM',
  "description" = 'CarbonLite MVP system factor metadata for pilot workflow validation.',
  "notes" = 'System default metadata. Verify applicable official factors before client or regulatory reporting.',
  "isOfficial" = false,
  "isActive" = true
WHERE EXISTS (
  SELECT 1
  FROM "FactorVersion" fv
  JOIN "Factor" f ON f."id" = fv."factorId"
  WHERE fv."sourceId" = "FactorSource"."id"
    AND f."isSystem" = true
    AND f."activityType" IN ('DIESEL', 'GASOLINE', 'NATURAL_GAS', 'ELECTRICITY', 'WATER')
);

UPDATE "FactorVersion"
SET
  "jurisdictionCountry" = 'Canada',
  "jurisdictionRegion" = CASE
    WHEN f."activityType" = 'ELECTRICITY' THEN 'Province Required'
    ELSE 'Canada (Generic)'
  END,
  "factorYear" = 2025,
  "confidenceLevel" = 'DEMO',
  "verificationStatus" = 'Internal Review Required',
  "verified" = false,
  "reviewedBy" = NULL,
  "reviewedAt" = NULL,
  "approvalSource" = NULL,
  "methodology" = CASE
    WHEN f."activityType" = 'ELECTRICITY' THEN 'Electricity emission factors vary by province. Replace with official provincial electricity factors before production use.'
    WHEN f."activityType" = 'WATER' THEN 'Estimated indirect emissions associated with municipal water treatment and distribution. Used for pilot workflow validation only.'
    ELSE 'Used for pilot validation. Intended for demonstration workflows only. Replace with official ECCC or provincial emission factors before production reporting.'
  END,
  "reviewNotes" = 'Internal review required before production use.',
  "notes" = CASE
    WHEN f."activityType" = 'ELECTRICITY' THEN 'Placeholder electricity factor for pilot testing only.'
    WHEN f."activityType" = 'WATER' THEN 'Tracked metric with optional estimated emissions. Not intended for regulatory reporting.'
    ELSE 'Default system factor included with CarbonLite MVP. Not intended for regulatory reporting.'
  END
FROM "Factor" f
WHERE "FactorVersion"."factorId" = f."id"
  AND f."isSystem" = true
  AND f."activityType" IN ('DIESEL', 'GASOLINE', 'NATURAL_GAS', 'ELECTRICITY', 'WATER');
