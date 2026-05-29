ALTER TABLE "ConversionFactor"
ADD COLUMN "sourceAuthority" TEXT,
ADD COLUMN "sourceDocument" TEXT,
ADD COLUMN "sourceYear" INTEGER,
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "methodology" TEXT,
ADD COLUMN "confidenceLevel" TEXT,
ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notes" TEXT;
