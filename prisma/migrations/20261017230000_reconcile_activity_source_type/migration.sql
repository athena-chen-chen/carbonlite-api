-- Preserve existing lineage values. Historical migrations recreated this as TEXT.
-- No rows/columns are dropped; unknown values fail the transaction before casting.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ActivityData" WHERE "sourceType"::text NOT IN ('MANUAL','IMPORT','API','DOCUMENT_AI')) THEN
    RAISE EXCEPTION 'Unsupported ActivityData sourceType exists; investigate before migration';
  END IF;
END $$;
ALTER TABLE "ActivityData" ALTER COLUMN "sourceType" DROP DEFAULT;
ALTER TABLE "ActivityData" ALTER COLUMN "sourceType" TYPE "RecordSourceType"
  USING "sourceType"::text::"RecordSourceType";
COMMIT;
