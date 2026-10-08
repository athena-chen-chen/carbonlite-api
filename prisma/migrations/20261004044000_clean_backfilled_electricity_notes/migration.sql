UPDATE "ActivityData"
SET
  "notes" = regexp_replace(
    regexp_replace(
      COALESCE("notes", ''),
      'No matching conversion factor is available for this record\\.',
      "calculationMessage",
      'gi'
    ),
    'No matching emission factor is available for this record\\.',
    "calculationMessage",
    'gi'
  ),
  "updatedAt" = NOW()
WHERE "activityType" = 'ELECTRICITY'
  AND "matchingStatus" = 'MATCHED'
  AND "calculationStatus" = 'CALCULATED'
  AND "calculationMessage" IS NOT NULL
  AND COALESCE("notes", '') ~* 'No matching (conversion|emission) factor is available for this record\\.';
