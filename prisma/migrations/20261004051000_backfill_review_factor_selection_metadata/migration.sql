UPDATE "SpreadsheetImportReviewRow"
SET
  "factorSelectionReason" = CASE
    WHEN "jurisdictionRegion" IS NOT NULL
      AND "matchedFactorName" IS NOT NULL
      AND "matchedFactorName" !~* "jurisdictionRegion"
      THEN 'GENERIC_JURISDICTION_FALLBACK'
    WHEN "matchedFactorSourceYear" IS NOT NULL
      AND "recordDate" IS NOT NULL
      AND "matchedFactorSourceYear" < EXTRACT(YEAR FROM "recordDate")::int
      THEN 'PRIOR_YEAR_FALLBACK'
    WHEN "matchedFactorSourceYear" IS NOT NULL
      AND "recordDate" IS NOT NULL
      AND "matchedFactorSourceYear" > EXTRACT(YEAR FROM "recordDate")::int
      THEN 'NEAREST_YEAR_PROXY'
    ELSE 'EXACT_MATCH'
  END,
  "factorSelectionExplanation" = TRIM(BOTH ' ' FROM CONCAT_WS(
    ' ',
    CASE
      WHEN "jurisdictionRegion" IS NOT NULL
        AND "matchedFactorName" IS NOT NULL
        AND "matchedFactorName" !~* "jurisdictionRegion"
        THEN 'Used the best available generic or country-level factor because no more specific jurisdiction factor was available.'
      ELSE NULL
    END,
    CASE
      WHEN "matchedFactorSourceYear" IS NOT NULL
        AND "recordDate" IS NOT NULL
        AND "matchedFactorSourceYear" < EXTRACT(YEAR FROM "recordDate")::int
        THEN CONCAT(
          'No exact ',
          EXTRACT(YEAR FROM "recordDate")::int,
          ' factor was available; used the latest prior factor year ',
          "matchedFactorSourceYear",
          '.'
        )
      WHEN "matchedFactorSourceYear" IS NOT NULL
        AND "recordDate" IS NOT NULL
        AND "matchedFactorSourceYear" > EXTRACT(YEAR FROM "recordDate")::int
        THEN CONCAT(
          'No prior factor was available for ',
          EXTRACT(YEAR FROM "recordDate")::int,
          '; used nearest factor year ',
          "matchedFactorSourceYear",
          '.'
        )
      ELSE 'Matched to the factor using the available activity context.'
    END
  ))
WHERE "matchedFactorId" IS NOT NULL
  AND "matchingStatus" = 'MATCHED'
  AND "calculationStatus" = 'CALCULATED'
  AND (
    "factorSelectionReason" IS NULL
    OR "factorSelectionExplanation" IS NULL
  );

UPDATE "ActivityData"
SET
  "factorSelectionReason" = CASE
    WHEN "jurisdictionRegion" IS NOT NULL
      AND "matchedFactorName" IS NOT NULL
      AND "matchedFactorName" !~* "jurisdictionRegion"
      THEN 'GENERIC_JURISDICTION_FALLBACK'
    WHEN "matchedFactorSourceYear" IS NOT NULL
      AND "recordDate" IS NOT NULL
      AND "matchedFactorSourceYear" < EXTRACT(YEAR FROM "recordDate")::int
      THEN 'PRIOR_YEAR_FALLBACK'
    WHEN "matchedFactorSourceYear" IS NOT NULL
      AND "recordDate" IS NOT NULL
      AND "matchedFactorSourceYear" > EXTRACT(YEAR FROM "recordDate")::int
      THEN 'NEAREST_YEAR_PROXY'
    ELSE 'EXACT_MATCH'
  END,
  "factorSelectionExplanation" = TRIM(BOTH ' ' FROM CONCAT_WS(
    ' ',
    CASE
      WHEN "jurisdictionRegion" IS NOT NULL
        AND "matchedFactorName" IS NOT NULL
        AND "matchedFactorName" !~* "jurisdictionRegion"
        THEN 'Used the best available generic or country-level factor because no more specific jurisdiction factor was available.'
      ELSE NULL
    END,
    CASE
      WHEN "matchedFactorSourceYear" IS NOT NULL
        AND "recordDate" IS NOT NULL
        AND "matchedFactorSourceYear" < EXTRACT(YEAR FROM "recordDate")::int
        THEN CONCAT(
          'No exact ',
          EXTRACT(YEAR FROM "recordDate")::int,
          ' factor was available; used the latest prior factor year ',
          "matchedFactorSourceYear",
          '.'
        )
      WHEN "matchedFactorSourceYear" IS NOT NULL
        AND "recordDate" IS NOT NULL
        AND "matchedFactorSourceYear" > EXTRACT(YEAR FROM "recordDate")::int
        THEN CONCAT(
          'No prior factor was available for ',
          EXTRACT(YEAR FROM "recordDate")::int,
          '; used nearest factor year ',
          "matchedFactorSourceYear",
          '.'
        )
      ELSE 'Matched to the factor using the available activity context.'
    END
  ))
WHERE "matchedFactorId" IS NOT NULL
  AND "matchingStatus" = 'MATCHED'
  AND "calculationStatus" = 'CALCULATED'
  AND (
    "factorSelectionReason" IS NULL
    OR "factorSelectionExplanation" IS NULL
  );
