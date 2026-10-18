BEGIN;
-- Additive durable snapshot/attestation storage. Existing calculations are not recomputed.
ALTER TABLE "ActivityData" ADD COLUMN "calculationSnapshot" JSONB,
  ADD COLUMN "calculationVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "calculatedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "boundaryStatus" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "boundaryVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "boundaryReviewedBy" TEXT, ADD COLUMN "boundaryReviewedByUserId" TEXT,
  ADD COLUMN "boundaryReviewedAt" TIMESTAMP(3), ADD COLUMN "boundaryReviewNote" TEXT,
  ADD COLUMN "boundaryReviewFingerprint" TEXT;
-- This exact 49.44/GJ corporate reference already existed in the frontend library.
-- Persist it so the backend can select/capture the same reference without frontend code.
INSERT INTO "ConversionFactor" ("id","name","type","activityType","jurisdiction","region","country","unit","factorValue","resultUnit","sourceName","sourceReference","sourceAuthority","sourceDocument","sourceUrl","sourceYear","verificationStatus","confidenceLevel","methodology","notes","verified","isDefault","isSystemDefault","applicability","emissionBasis","methodologyProvenance","createdAt","updatedAt")
VALUES ('eccc-natural-gas-canada-generic-gj-2025','Natural Gas - Canada Generic','EMISSION','NATURAL_GAS','Canada (Generic)','Canada','Canada','GJ',49.44,'kgCO2e',
'ECCC Table A8 national fuel energy emission factor','Table A8: Mass of CO2 equivalent emissions emitted per quantity of energy for various fuels',
'Environment and Climate Change Canada','Greenhouse gas and air pollutant emissions projections – 2025',
'https://www.canada.ca/en/environment-climate-change/services/climate-change/greenhouse-gas-emissions/projections/2025-report.html',2025,'INTERNAL_REVIEW_REQUIRED','HIGH',
'Table A8 publishes Natural Gas at 49.44 g CO2e/MJ. CarbonLite stores the equivalent direct factor as 49.44 kg CO2e/GJ.',
'Canada-generic fallback estimate from ECCC Table A8. Not Alberta-specific, facility-specific, or compliance-certified.',false,true,true,'CORPORATE_INVENTORY','DIRECT_CO2E',
'{"sourceVersion":"ECCC_EPR_2025_TABLE_A8","quantityBasis":"ENERGY_HHV"}'::jsonb,NOW(),NOW())
ON CONFLICT ("id") DO NOTHING;

COMMIT;
