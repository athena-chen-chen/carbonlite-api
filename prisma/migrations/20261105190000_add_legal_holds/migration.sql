CREATE TYPE "LegalHoldScopeType" AS ENUM ('ORGANIZATION', 'DOCUMENT');
CREATE TYPE "LegalHoldStatus" AS ENUM ('PROVISIONAL', 'ACTIVE', 'RELEASE_PENDING', 'RELEASED');
CREATE TYPE "LegalHoldEventAction" AS ENUM ('ACTIVATED', 'RELEASE_REQUESTED', 'RELEASE_APPROVED', 'RELEASED', 'BLOCKED_DELETION');

CREATE TABLE "LegalHold" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseReference" TEXT NOT NULL,
    "scopeType" "LegalHoldScopeType" NOT NULL,
    "status" "LegalHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorityReference" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "nextReviewAt" TIMESTAMP(3),
    "releaseRequestedById" TEXT,
    "releaseRequestedAt" TIMESTAMP(3),
    "releaseApprovedById" TEXT,
    "releaseApprovedAt" TIMESTAMP(3),
    "releaseAuthorityReference" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalHold_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegalHoldDocument" (
    "id" TEXT NOT NULL,
    "legalHoldId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalHoldDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegalHoldEvent" (
    "id" TEXT NOT NULL,
    "legalHoldId" TEXT NOT NULL,
    "organizationIdHash" TEXT NOT NULL,
    "caseReference" TEXT NOT NULL,
    "action" "LegalHoldEventAction" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorityReference" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "operation" TEXT,
    "targetCount" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalHoldEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalHold_caseReference_key" ON "LegalHold"("caseReference");
CREATE INDEX "LegalHold_organizationId_status_effectiveAt_idx" ON "LegalHold"("organizationId", "status", "effectiveAt");
CREATE UNIQUE INDEX "LegalHoldDocument_legalHoldId_documentId_key" ON "LegalHoldDocument"("legalHoldId", "documentId");
CREATE INDEX "LegalHoldDocument_organizationId_documentId_idx" ON "LegalHoldDocument"("organizationId", "documentId");
CREATE INDEX "LegalHoldEvent_legalHoldId_occurredAt_idx" ON "LegalHoldEvent"("legalHoldId", "occurredAt");
CREATE INDEX "LegalHoldEvent_organizationIdHash_occurredAt_idx" ON "LegalHoldEvent"("organizationIdHash", "occurredAt");

ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LegalHoldDocument" ADD CONSTRAINT "LegalHoldDocument_legalHoldId_fkey"
    FOREIGN KEY ("legalHoldId") REFERENCES "LegalHold"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LegalHoldDocument" ADD CONSTRAINT "LegalHoldDocument_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
