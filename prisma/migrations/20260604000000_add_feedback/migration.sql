CREATE TYPE "FeedbackType" AS ENUM ('BUG', 'SUGGESTION', 'QUESTION', 'OTHER');

CREATE TYPE "FeedbackStatus" AS ENUM ('NEW', 'REVIEWED', 'CLOSED');

CREATE TABLE "Feedback" (
  "id" TEXT NOT NULL,
  "type" "FeedbackType" NOT NULL,
  "intent" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "email" TEXT,
  "page" TEXT,
  "url" TEXT,
  "organizationId" TEXT NOT NULL,
  "userAgent" TEXT,
  "status" "FeedbackStatus" NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Feedback_organizationId_idx" ON "Feedback"("organizationId");
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

ALTER TABLE "Feedback"
  ADD CONSTRAINT "Feedback_organizationId_fkey"
  FOREIGN KEY ("organizationId")
  REFERENCES "Organization"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
