CREATE TYPE "OrganizationCustomerStatus" AS ENUM ('PENDING', 'PILOT', 'ACTIVE', 'SUSPENDED', 'DEMO');

ALTER TABLE "Organization"
  ADD COLUMN "customerStatus" "OrganizationCustomerStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "provisionedAt" TIMESTAMP(3);

UPDATE "Organization"
SET "customerStatus" = CASE
  WHEN "name" = 'CarbonLite Sample Workspace' THEN 'DEMO'::"OrganizationCustomerStatus"
  WHEN "allowDemoFactorsForCalculations" = true THEN 'PILOT'::"OrganizationCustomerStatus"
  ELSE 'PENDING'::"OrganizationCustomerStatus"
END;
