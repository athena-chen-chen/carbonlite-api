ALTER TABLE "ConversionFactor"
ADD COLUMN IF NOT EXISTS "isSystemDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "ConversionFactor_isSystemDefault_idx"
ON "ConversionFactor"("isSystemDefault");

INSERT INTO "ConversionFactor" (
  "id",
  "organizationId",
  "name",
  "type",
  "activityType",
  "unit",
  "factorValue",
  "resultUnit",
  "sourceName",
  "sourceReference",
  "isDefault",
  "isSystemDefault",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  NULL,
  seed.name,
  'EMISSION'::"FactorType",
  seed."activityType"::"ActivityType",
  seed.unit,
  seed."factorValue",
  'kgCO2e',
  'CarbonLite system defaults',
  'mvp-seed',
  true,
  true,
  NOW(),
  NOW()
FROM (
  VALUES
    ('Diesel emission factor', 'DIESEL', 'liters', 2.68::numeric),
    ('Gasoline emission factor', 'GASOLINE', 'liters', 2.31::numeric),
    ('Natural gas emission factor', 'NATURAL_GAS', 'm3', 1.89::numeric),
    ('Electricity emission factor', 'ELECTRICITY', 'kWh', 0.53::numeric),
    ('Air travel emission factor', 'AIR_TRAVEL', 'km', 0.115::numeric),
    ('Hotel emission factor', 'HOTEL', 'nights', 15::numeric),
    ('Shipping emission factor', 'SHIPPING', 'ton-km', 0.09::numeric)
) AS seed(name, "activityType", unit, "factorValue")
WHERE NOT EXISTS (
  SELECT 1
  FROM "ConversionFactor" existing
  WHERE existing."isSystemDefault" = true
    AND existing."type" = 'EMISSION'::"FactorType"
    AND existing."activityType" = seed."activityType"::"ActivityType"
    AND lower(existing."unit") = lower(seed.unit)
);
