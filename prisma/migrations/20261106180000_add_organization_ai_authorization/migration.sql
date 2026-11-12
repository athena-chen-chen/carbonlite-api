CREATE TYPE "AiAuthorizationStatus" AS ENUM ('DISABLED', 'ENABLED', 'WITHDRAWN');

CREATE TABLE "OrganizationAiAuthorization" (
    "organizationId" TEXT NOT NULL,
    "status" "AiAuthorizationStatus" NOT NULL DEFAULT 'DISABLED',
    "consentVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "processingScope" TEXT NOT NULL,
    "evidenceReference" TEXT NOT NULL,
    "authorizedRepresentativeReference" TEXT NOT NULL,
    "verifiedById" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAiAuthorization_pkey" PRIMARY KEY ("organizationId")
);

CREATE INDEX "OrganizationAiAuthorization_status_provider_processingScope_idx"
ON "OrganizationAiAuthorization"("status", "provider", "processingScope");

CREATE INDEX "OrganizationAiAuthorization_consentVersion_idx"
ON "OrganizationAiAuthorization"("consentVersion");

ALTER TABLE "OrganizationAiAuthorization"
ADD CONSTRAINT "OrganizationAiAuthorization_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
