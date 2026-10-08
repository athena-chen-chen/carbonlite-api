ALTER TABLE "ActivityData"
ADD COLUMN "sourceSheetName" TEXT,
ADD COLUMN "factorSelectionReason" TEXT,
ADD COLUMN "factorSelectionExplanation" TEXT;

ALTER TABLE "SpreadsheetImportReviewRow"
ADD COLUMN "factorSelectionReason" TEXT,
ADD COLUMN "factorSelectionExplanation" TEXT;

WITH normalized_costs AS (
  SELECT
    id,
    regexp_replace(
      COALESCE("rawSourceRow"->>'Cost CAD', "rawSourceRow"->>'costCad', "rawSourceRow"->>'Cost', ''),
      '[^0-9.\-]',
      '',
      'g'
    ) AS normalized_cost
  FROM "SpreadsheetImportReviewRow"
  WHERE "costCad" IS NULL
)
UPDATE "SpreadsheetImportReviewRow" sr
SET
  "costCad" = nc.normalized_cost::numeric(18, 2),
  "costCurrency" = COALESCE(NULLIF(sr."costCurrency", ''), 'CAD')
FROM normalized_costs nc
WHERE sr.id = nc.id
  AND nc.normalized_cost ~ '^-?[0-9]+(\.[0-9]+)?$';

UPDATE "ActivityData" ad
SET
  "sourceSheetName" = COALESCE(ad."sourceSheetName", sr."sourceSheetName"),
  "costCad" = COALESCE(ad."costCad", sr."costCad"),
  "costCurrency" = COALESCE(NULLIF(ad."costCurrency", ''), sr."costCurrency"),
  "factorSelectionReason" = COALESCE(ad."factorSelectionReason", sr."factorSelectionReason"),
  "factorSelectionExplanation" = COALESCE(ad."factorSelectionExplanation", sr."factorSelectionExplanation")
FROM "SpreadsheetImportReviewRow" sr
WHERE ad."organizationId" = sr."organizationId"
  AND COALESCE(ad."sourceDocumentId", '') = COALESCE(sr."sourceDocumentId", '')
  AND COALESCE(ad."sourceFileName", '') = COALESCE(sr."sourceFileName", '')
  AND COALESCE(ad."sourceRow", '') = COALESCE(sr."sourceRow", '')
  AND COALESCE(ad."sourceReference", '') = COALESCE(sr."sourceReference", '')
  AND (
    ad."sourceSheetName" IS NULL
    OR ad."costCad" IS NULL
    OR ad."costCurrency" IS NULL
    OR ad."factorSelectionReason" IS NULL
    OR ad."factorSelectionExplanation" IS NULL
  );
