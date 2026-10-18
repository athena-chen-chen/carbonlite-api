-- Backfill records that were normalized correctly but saved while
-- province-specific electricity factors were incorrectly marked as placeholders.
UPDATE "ActivityData" ad
SET
  "matchingStatus" = 'MATCHED',
  "calculationStatus" = 'CALCULATED',
  "reportTreatment" = 'INCLUDED',
  "scope" = COALESCE(ad."scope", 'SCOPE_2'),
  "matchedFactorId" = cf."id",
  "matchedFactorName" = cf."name",
  "matchedFactorSourceYear" = cf."sourceYear",
  "matchedFactorValue" = cf."factorValue"::double precision,
  "matchedFactorUnit" = CONCAT(COALESCE(cf."resultUnit", 'kgCO2e'), '/', cf."unit"),
  "matchedFactorSourceAuthority" = cf."sourceAuthority",
  "matchedFactorSourceDocument" = cf."sourceDocument",
  "matchedFactorVerificationStatus" = cf."verificationStatus",
  "matchedFactorConfidenceLevel" = cf."confidenceLevel",
  "calculatedEmissionsKgCO2e" = (ad."quantity"::double precision * cf."factorValue"::double precision),
  "calculationMessage" = CASE
    WHEN cf."sourceYear" IS NOT NULL AND COALESCE(ad."recordYear", EXTRACT(YEAR FROM ad."recordDate")::int) > cf."sourceYear"
      THEN CONCAT('Matched factor. Using latest available factor year: ', cf."sourceYear", '.')
    ELSE 'Matched factor. This record is included in emissions totals.'
  END,
  "notes" = regexp_replace(
    COALESCE(ad."notes", ''),
    '(No matching conversion factor is available for this record\\.?|No matching emission factor is available for this record\\.?)',
    CASE
      WHEN cf."sourceYear" IS NOT NULL AND COALESCE(ad."recordYear", EXTRACT(YEAR FROM ad."recordDate")::int) > cf."sourceYear"
        THEN CONCAT('Matched factor. Using latest available factor year: ', cf."sourceYear", '.')
      ELSE 'Matched factor. This record is included in emissions totals.'
    END,
    'gi'
  ),
  "updatedAt" = NOW()
FROM "ConversionFactor" cf
WHERE ad."activityType" = 'ELECTRICITY'
  AND ad."unit" = 'kWh'
  AND ad."jurisdictionCountry" = 'Canada'
  AND ad."jurisdictionRegion" = cf."jurisdiction"
  AND COALESCE(ad."matchingStatus", '') = 'MISSING_FACTOR'
  AND cf."isSystemDefault" = true
  AND cf."activityType" = 'ELECTRICITY'
  AND cf."type" = 'EMISSION'
  AND cf."unit" = 'kWh'
  AND COALESCE(cf."jurisdiction", '') <> 'Province Required'
  AND cf."factorValue" IS NOT NULL;
