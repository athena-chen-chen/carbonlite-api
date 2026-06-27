-- Factor version history and reproducibility support
ALTER TABLE "FactorChangeLog"
  ADD COLUMN "oldFactorVersionId" TEXT,
  ADD COLUMN "newFactorVersionId" TEXT;

ALTER TABLE "MetricResult"
  ADD COLUMN "factorVersionId" TEXT;

CREATE INDEX "FactorChangeLog_oldFactorVersionId_idx" ON "FactorChangeLog"("oldFactorVersionId");
CREATE INDEX "FactorChangeLog_newFactorVersionId_idx" ON "FactorChangeLog"("newFactorVersionId");
CREATE INDEX "MetricResult_factorVersionId_idx" ON "MetricResult"("factorVersionId");

ALTER TABLE "FactorChangeLog" ADD CONSTRAINT "FactorChangeLog_oldFactorVersionId_fkey" FOREIGN KEY ("oldFactorVersionId") REFERENCES "FactorVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FactorChangeLog" ADD CONSTRAINT "FactorChangeLog_newFactorVersionId_fkey" FOREIGN KEY ("newFactorVersionId") REFERENCES "FactorVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
