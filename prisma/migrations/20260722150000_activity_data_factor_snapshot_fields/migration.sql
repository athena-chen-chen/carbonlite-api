ALTER TABLE "ActivityData"
ADD COLUMN IF NOT EXISTS "matchedFactorValue" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "matchedFactorUnit" TEXT,
ADD COLUMN IF NOT EXISTS "matchedFactorVersion" TEXT,
ADD COLUMN IF NOT EXISTS "matchedFactorSourceAuthority" TEXT,
ADD COLUMN IF NOT EXISTS "matchedFactorSourceDocument" TEXT,
ADD COLUMN IF NOT EXISTS "matchedFactorVerificationStatus" TEXT,
ADD COLUMN IF NOT EXISTS "matchedFactorConfidenceLevel" TEXT,
ADD COLUMN IF NOT EXISTS "matchedFactorAssumptions" TEXT;
