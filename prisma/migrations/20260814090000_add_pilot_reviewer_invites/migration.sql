ALTER TABLE "User"
  ADD COLUMN "accountType" TEXT,
  ADD COLUMN "accountExpiresAt" TIMESTAMP(3),
  ADD COLUMN "passwordSetupRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "passwordSetupTokenHash" TEXT,
  ADD COLUMN "passwordSetupTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "passwordSetupTokenUsedAt" TIMESTAMP(3);

CREATE INDEX "User_accountType_idx" ON "User"("accountType");
CREATE INDEX "User_passwordSetupTokenHash_idx" ON "User"("passwordSetupTokenHash");
