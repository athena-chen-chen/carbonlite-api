-- Province-specific electricity factors are usable pilot defaults.
-- Only the generic "Province Required" electricity placeholder should be
-- excluded by canonical matching.
UPDATE "ConversionFactor"
SET
  "confidenceLevel" = 'Low',
  "notes" = COALESCE(
    NULLIF("notes", ''),
    'Pilot-stage default electricity factor. Uses jurisdiction-specific electricity factor and latest available prior-year factor where no reporting-year factor exists. Replace with reviewed official factor before formal reporting.'
  )
WHERE "isSystemDefault" = true
  AND "activityType" = 'ELECTRICITY'
  AND COALESCE("jurisdiction", '') <> 'Province Required'
  AND COALESCE("confidenceLevel", '') ILIKE '%placeholder%';

UPDATE "FactorVersion" fv
SET
  "confidenceLevel" = 'DEMO',
  "notes" = COALESCE(
    NULLIF(fv."notes", ''),
    'Pilot-stage default electricity factor. Uses jurisdiction-specific electricity factor and latest available prior-year factor where no reporting-year factor exists. Replace with reviewed official factor before formal reporting.'
  )
FROM "Factor" f
WHERE fv."factorId" = f."id"
  AND f."isSystem" = true
  AND f."activityType" = 'ELECTRICITY'
  AND COALESCE(fv."jurisdictionRegion", '') <> 'Province Required'
  AND COALESCE(fv."confidenceLevel"::text, '') ILIKE '%placeholder%';
