ALTER TABLE "ActivityData"
  ADD COLUMN "costCad" DECIMAL(18,2),
  ADD COLUMN "costCurrency" TEXT;

ALTER TABLE "SpreadsheetImportReviewRow"
  ADD COLUMN "costCad" DECIMAL(18,2),
  ADD COLUMN "costCurrency" TEXT;
