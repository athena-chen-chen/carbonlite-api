-- Additive only. No factors are seeded or reclassified.
CREATE TYPE "FactorApplicability" AS ENUM ('CORPORATE_INVENTORY', 'ALBERTA_OFFSET_PROJECT', 'ALBERTA_TIER_SGRR', 'REFERENCE_ONLY');
CREATE TYPE "EmissionBasis" AS ENUM ('DIRECT_CO2E', 'CO2_COMPONENT', 'CH4_COMPONENT', 'N2O_COMPONENT');
ALTER TABLE "FactorVersion" ADD COLUMN "applicability" "FactorApplicability", ADD COLUMN "emissionBasis" "EmissionBasis", ADD COLUMN "methodologyProvenance" JSONB;
ALTER TABLE "ConversionFactor" ADD COLUMN "applicability" "FactorApplicability", ADD COLUMN "emissionBasis" "EmissionBasis", ADD COLUMN "methodologyProvenance" JSONB;
