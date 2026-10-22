-- Rename current library documents only. Historical calculation evidence is immutable.
-- Exact equality makes this safe to rerun and leaves unrelated provenance untouched.
UPDATE "ConversionFactor"
SET "sourceDocument" = 'CarbonLite Default Factor Library v1.0'
WHERE "sourceDocument" = 'CarbonLite MVP Default Factors v1.0';

UPDATE "FactorSource"
SET "sourceDocument" = 'CarbonLite Default Factor Library v1.0'
WHERE "sourceDocument" = 'CarbonLite MVP Default Factors v1.0';
