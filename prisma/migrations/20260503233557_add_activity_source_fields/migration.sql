/*
  Warnings:

  - The `sourceType` column on the `ActivityData` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "ActivityData" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "sourceDocumentId" TEXT,
ADD COLUMN     "sourceFileName" TEXT,
DROP COLUMN "sourceType",
ADD COLUMN     "sourceType" TEXT NOT NULL DEFAULT 'MANUAL';
