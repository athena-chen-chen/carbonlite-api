UPDATE "ActivityData"
SET
  "notes" = replace(
    replace(
      COALESCE("notes", ''),
      'No matching conversion factor is available for this record.',
      "calculationMessage"
    ),
    'No matching emission factor is available for this record.',
    "calculationMessage"
  ),
  "updatedAt" = NOW()
WHERE "activityType" = 'ELECTRICITY'
  AND "matchingStatus" = 'MATCHED'
  AND "calculationStatus" = 'CALCULATED'
  AND "calculationMessage" IS NOT NULL
  AND (
    COALESCE("notes", '') ILIKE '%No matching conversion factor is available for this record.%'
    OR COALESCE("notes", '') ILIKE '%No matching emission factor is available for this record.%'
  );
