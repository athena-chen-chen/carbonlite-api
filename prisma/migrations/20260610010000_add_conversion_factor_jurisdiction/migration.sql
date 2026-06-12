ALTER TABLE "ConversionFactor"
ADD COLUMN "jurisdiction" TEXT;

UPDATE "ConversionFactor"
SET "jurisdiction" = CASE
  WHEN "region" IS NOT NULL AND "country" IS NOT NULL
    THEN "region" || ', ' || "country"
  WHEN "region" IS NOT NULL
    THEN "region"
  ELSE "country"
END
WHERE "jurisdiction" IS NULL
  AND ("region" IS NOT NULL OR "country" IS NOT NULL);

CREATE INDEX "ConversionFactor_jurisdiction_idx"
ON "ConversionFactor"("jurisdiction");

CREATE INDEX "ConversionFactor_sourceYear_idx"
ON "ConversionFactor"("sourceYear");
