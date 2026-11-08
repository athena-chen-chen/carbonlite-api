CREATE TYPE "QuotaUsageType" AS ENUM ('DOCUMENT_UPLOAD');

ALTER TABLE "AIJob" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE TABLE "OrganizationQuota" (
  "organizationId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "periodDays" INTEGER NOT NULL DEFAULT 28,
  "uploadLimit" INTEGER NOT NULL DEFAULT 20,
  "dailyUploadLimit" INTEGER NOT NULL DEFAULT 10,
  "maxFileSizeBytes" INTEGER NOT NULL DEFAULT 10485760,
  "maxConcurrentExtractions" INTEGER NOT NULL DEFAULT 2,
  "maxImportRows" INTEGER NOT NULL DEFAULT 500,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationQuota_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "OrganizationQuota_positive_limits" CHECK (
    "periodDays" > 0 AND "uploadLimit" > 0 AND "dailyUploadLimit" > 0 AND
    "maxFileSizeBytes" > 0 AND "maxConcurrentExtractions" > 0 AND "maxImportRows" > 0
  ),
  CONSTRAINT "OrganizationQuota_safe_limits" CHECK (
    "periodDays" <= 365 AND "maxFileSizeBytes" <= 10485760 AND
    "maxConcurrentExtractions" <= 100 AND "maxImportRows" <= 10000
  )
);

CREATE TABLE "OrganizationQuotaPeriod" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "resetByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationQuotaPeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationQuotaPeriod_valid_range" CHECK (
    "endsAt" > "startsAt" AND ("closedAt" IS NULL OR "closedAt" >= "startsAt")
  )
);

CREATE TABLE "OrganizationQuotaUsage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "userId" TEXT,
  "documentId" TEXT,
  "usageType" "QuotaUsageType" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "OrganizationQuotaUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationQuotaPeriod_organizationId_startsAt_key" ON "OrganizationQuotaPeriod"("organizationId", "startsAt");
CREATE UNIQUE INDEX "OrganizationQuotaPeriod_one_open_period" ON "OrganizationQuotaPeriod"("organizationId") WHERE "closedAt" IS NULL;
CREATE INDEX "OrganizationQuotaPeriod_organizationId_closedAt_endsAt_idx" ON "OrganizationQuotaPeriod"("organizationId", "closedAt", "endsAt");
CREATE UNIQUE INDEX "OrganizationQuotaUsage_documentId_usageType_key" ON "OrganizationQuotaUsage"("documentId", "usageType");
CREATE INDEX "OrganizationQuotaUsage_organizationId_usageType_occurredAt_idx" ON "OrganizationQuotaUsage"("organizationId", "usageType", "occurredAt");
CREATE INDEX "OrganizationQuotaUsage_periodId_usageType_idx" ON "OrganizationQuotaUsage"("periodId", "usageType");
CREATE INDEX "AIJob_organizationId_jobType_status_leaseExpiresAt_idx" ON "AIJob"("organizationId", "jobType", "status", "leaseExpiresAt");

ALTER TABLE "OrganizationQuota" ADD CONSTRAINT "OrganizationQuota_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationQuotaPeriod" ADD CONSTRAINT "OrganizationQuotaPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationQuotaUsage" ADD CONSTRAINT "OrganizationQuotaUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationQuotaUsage" ADD CONSTRAINT "OrganizationQuotaUsage_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "OrganizationQuotaPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationQuotaUsage" ADD CONSTRAINT "OrganizationQuotaUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationQuotaUsage" ADD CONSTRAINT "OrganizationQuotaUsage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
