-- Preserve reviewed factor derivations that require more than eight decimal places.
ALTER TABLE "FactorVersion"
ALTER COLUMN "factorValue" TYPE DECIMAL(30, 16);

ALTER TABLE "ConversionFactor"
ALTER COLUMN "factorValue" TYPE DECIMAL(30, 16);
