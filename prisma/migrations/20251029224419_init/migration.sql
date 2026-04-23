/*
  Warnings:

  - You are about to drop the column `category` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `factorValue` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `notes` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `region` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `subCategory` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `year` on the `Factor` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `User` table. All the data in the column will be lost.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `Emission` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `name` to the `Factor` table without a default value. This is not possible if the table is not empty.
  - Added the required column `value` to the `Factor` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'REPORTING', 'DATA_ENTRY');

-- DropForeignKey
ALTER TABLE "public"."Emission" DROP CONSTRAINT "Emission_factorId_fkey";

-- AlterTable
ALTER TABLE "Factor" DROP COLUMN "category",
DROP COLUMN "createdAt",
DROP COLUMN "factorValue",
DROP COLUMN "notes",
DROP COLUMN "region",
DROP COLUMN "subCategory",
DROP COLUMN "year",
ADD COLUMN     "method" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "updatedById" TEXT,
ADD COLUMN     "value" DOUBLE PRECISION NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "name",
DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'DATA_ENTRY';

-- DropTable
DROP TABLE "public"."Emission";

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fuelType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "FuelRecord_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Factor" ADD CONSTRAINT "Factor_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelRecord" ADD CONSTRAINT "FuelRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelRecord" ADD CONSTRAINT "FuelRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
