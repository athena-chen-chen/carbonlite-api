CREATE TABLE "UserActivityEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "eventName" TEXT NOT NULL,
    "page" TEXT,
    "url" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserActivityEvent_organizationId_idx" ON "UserActivityEvent"("organizationId");
CREATE INDEX "UserActivityEvent_userId_idx" ON "UserActivityEvent"("userId");
CREATE INDEX "UserActivityEvent_eventName_idx" ON "UserActivityEvent"("eventName");
CREATE INDEX "UserActivityEvent_page_idx" ON "UserActivityEvent"("page");
CREATE INDEX "UserActivityEvent_entityType_entityId_idx" ON "UserActivityEvent"("entityType", "entityId");
CREATE INDEX "UserActivityEvent_createdAt_idx" ON "UserActivityEvent"("createdAt");

ALTER TABLE "UserActivityEvent" ADD CONSTRAINT "UserActivityEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserActivityEvent" ADD CONSTRAINT "UserActivityEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
