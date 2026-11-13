CREATE TYPE "AiAuthorizedDataMode" AS ENUM ('SYNTHETIC_TEST_ONLY', 'REAL_CUSTOMER_DATA');
CREATE TYPE "IngestionDataMode" AS ENUM ('SYNTHETIC_TEST', 'REAL_CUSTOMER_DATA');
CREATE TYPE "RealDataAuthorizationStatus" AS ENUM ('SYNTHETIC_ONLY', 'REAL_DATA_APPROVED', 'WITHDRAWN');

ALTER TABLE "OrganizationAiAuthorization"
  ADD COLUMN "authorizedDataMode" "AiAuthorizedDataMode" NOT NULL DEFAULT 'SYNTHETIC_TEST_ONLY',
  ADD COLUMN "realDataApprovalRevision" INTEGER;

ALTER TABLE "OrganizationAiAuthorization"
  ADD CONSTRAINT "OrganizationAiAuthorization_data_mode_revision_check"
  CHECK (
    ("authorizedDataMode" = 'SYNTHETIC_TEST_ONLY' AND "realDataApprovalRevision" IS NULL)
    OR
    ("authorizedDataMode" = 'REAL_CUSTOMER_DATA' AND "realDataApprovalRevision" IS NOT NULL)
  );

ALTER TABLE "Document"
  ADD COLUMN "ingestionDataMode" "IngestionDataMode" NOT NULL DEFAULT 'SYNTHETIC_TEST';

CREATE TABLE "OrganizationRealDataAuthorization" (
  "organizationId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "status" "RealDataAuthorizationStatus" NOT NULL DEFAULT 'SYNTHETIC_ONLY',
  "approvalRevision" INTEGER NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "agreementEvidenceReference" TEXT NOT NULL,
  "allowedDataScopeReference" TEXT NOT NULL,
  "privacySecurityReadinessReference" TEXT NOT NULL,
  "approvedById" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "reviewDueAt" TIMESTAMP(3),
  "withdrawnById" TEXT,
  "withdrawnAt" TIMESTAMP(3),
  "withdrawalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrganizationRealDataAuthorization_pkey" PRIMARY KEY ("organizationId")
);

CREATE TABLE "RealDataAuthorizationEvidence" (
  "id" TEXT NOT NULL,
  "hmacKeyVersion" TEXT NOT NULL,
  "organizationIdHash" TEXT NOT NULL,
  "authorizationDecisionId" TEXT NOT NULL,
  "approvalRevision" INTEGER NOT NULL,
  "decision" "RealDataAuthorizationStatus" NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "allowedDataScopeCode" TEXT NOT NULL,
  "agreementEvidenceReferenceHash" TEXT NOT NULL,
  "readinessEvidenceReferenceHash" TEXT NOT NULL,
  "approvedByIdHash" TEXT,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "reviewDueAt" TIMESTAMP(3),
  "withdrawnByIdHash" TEXT,
  "withdrawnAt" TIMESTAMP(3),
  "withdrawalReasonCode" TEXT,
  "workspaceErasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RealDataAuthorizationEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationRealDataAuthorization_decisionId_key"
  ON "OrganizationRealDataAuthorization"("decisionId");
CREATE INDEX "OrganizationRealDataAuthorization_status_effectiveAt_idx"
  ON "OrganizationRealDataAuthorization"("status", "effectiveAt");
CREATE INDEX "OrganizationRealDataAuthorization_policyVersion_idx"
  ON "OrganizationRealDataAuthorization"("policyVersion");
CREATE INDEX "OrganizationRealDataAuthorization_expiresAt_idx"
  ON "OrganizationRealDataAuthorization"("expiresAt");
CREATE INDEX "OrganizationRealDataAuthorization_reviewDueAt_idx"
  ON "OrganizationRealDataAuthorization"("reviewDueAt");
CREATE INDEX "RealDataAuthEvidence_orgHash_revision_idx"
  ON "RealDataAuthorizationEvidence"("organizationIdHash", "approvalRevision");
CREATE INDEX "RealDataAuthorizationEvidence_authorizationDecisionId_idx"
  ON "RealDataAuthorizationEvidence"("authorizationDecisionId");
CREATE INDEX "RealDataAuthorizationEvidence_approvedAt_idx"
  ON "RealDataAuthorizationEvidence"("approvedAt");

ALTER TABLE "OrganizationRealDataAuthorization"
  ADD CONSTRAINT "OrganizationRealDataAuthorization_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
