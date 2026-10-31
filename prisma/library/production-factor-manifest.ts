import type { Prisma } from '@prisma/client';
import {
  ECCC_DIESEL_2026_FACTOR_ID,
  ECCC_GASOLINE_2026_FACTOR_ID,
  ECCC_REFINED_PETROLEUM_2026_SOURCE_ID,
  ecccDiesel2026Factor,
  ecccDiesel2026Legacy,
  ecccDiesel2026Version,
  ecccGasoline2026Factor,
  ecccGasoline2026Legacy,
  ecccGasoline2026Version,
  ecccRefinedPetroleum2026Source,
} from './eccc-refined-petroleum-2026';
import {
  ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
  ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
  ecccNaturalGasAlberta2026Factor,
  ecccNaturalGasAlberta2026Legacy,
  ecccNaturalGasAlberta2026Source,
  ecccNaturalGasAlberta2026Version,
} from './eccc-natural-gas-alberta-2026';
import {
  DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
  DESNZ_HOTEL_CANADA_2026_SOURCE_ID,
  desnzHotelCanada2026Factor,
  desnzHotelCanada2026Legacy,
  desnzHotelCanada2026Source,
  desnzHotelCanada2026Version,
} from './desnz-hotel-canada-2026';
import {
  EPA_AIR_TRAVEL_2025_PACK,
  EPA_AIR_TRAVEL_2025_SOURCE_ID,
  epaAirTravel2025Source,
} from './epa-air-travel-2025';
import {
  ECCC_ELECTRICITY_CANADA_2026_PACK,
  ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID,
  ecccElectricityCanada2026Source,
} from './eccc-electricity-canada-2026';

type ManifestFactor = Prisma.FactorCreateWithoutVersionsInput;
type ManifestVersion = Prisma.FactorVersionUncheckedCreateInput;
type ManifestLegacy = Prisma.ConversionFactorUncheckedCreateInput;
type ManifestSource = Prisma.FactorSourceCreateWithoutVersionsInput;

export type ProductionFactorManifestEntry = {
  factorId: string;
  sourceId: string;
  selectionKey: string;
  factor: ManifestFactor;
  version: ManifestVersion;
  legacy: ManifestLegacy;
  source: ManifestSource;
};

function selectionKey(version: ManifestVersion): string {
  const provenance = version.methodologyProvenance as { haulCategory?: string } | undefined;
  return [
    String((version as { activityType?: string }).activityType ?? ''),
    version.factorYear,
    version.inputUnit,
    version.jurisdictionCountry ?? '',
    version.jurisdictionRegion ?? '',
    provenance?.haulCategory ?? '',
  ].join('|');
}

function entry(
  factorId: string,
  sourceId: string,
  factor: ManifestFactor,
  version: ManifestVersion,
  legacy: ManifestLegacy,
  source: ManifestSource,
): ProductionFactorManifestEntry {
  const keyVersion = { ...version, activityType: factor.activityType } as ManifestVersion & { activityType: string };
  return { factorId, sourceId, selectionKey: selectionKey(keyVersion), factor, version, legacy, source };
}

export const PRODUCTION_FACTOR_MANIFEST: readonly ProductionFactorManifestEntry[] = [
  entry(ECCC_GASOLINE_2026_FACTOR_ID, ECCC_REFINED_PETROLEUM_2026_SOURCE_ID,
    ecccGasoline2026Factor, ecccGasoline2026Version, ecccGasoline2026Legacy, ecccRefinedPetroleum2026Source),
  entry(ECCC_DIESEL_2026_FACTOR_ID, ECCC_REFINED_PETROLEUM_2026_SOURCE_ID,
    ecccDiesel2026Factor, ecccDiesel2026Version, ecccDiesel2026Legacy, ecccRefinedPetroleum2026Source),
  entry(ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID, ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
    ecccNaturalGasAlberta2026Factor, ecccNaturalGasAlberta2026Version,
    ecccNaturalGasAlberta2026Legacy, ecccNaturalGasAlberta2026Source),
  entry(DESNZ_HOTEL_CANADA_2026_FACTOR_ID, DESNZ_HOTEL_CANADA_2026_SOURCE_ID,
    desnzHotelCanada2026Factor, desnzHotelCanada2026Version,
    desnzHotelCanada2026Legacy, desnzHotelCanada2026Source),
  ...EPA_AIR_TRAVEL_2025_PACK.map((packEntry) => entry(
    packEntry.factorId, EPA_AIR_TRAVEL_2025_SOURCE_ID, packEntry.factor,
    packEntry.version, packEntry.legacy, epaAirTravel2025Source,
  )),
  ...ECCC_ELECTRICITY_CANADA_2026_PACK.map((packEntry) => entry(
    packEntry.factorId, ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID, packEntry.factor,
    packEntry.version, packEntry.legacy, ecccElectricityCanada2026Source,
  )),
];

export const EXPECTED_PRODUCTION_FACTOR_COUNT = 20;

if (PRODUCTION_FACTOR_MANIFEST.length !== EXPECTED_PRODUCTION_FACTOR_COUNT ||
    new Set(PRODUCTION_FACTOR_MANIFEST.map((item) => item.factorId)).size !== EXPECTED_PRODUCTION_FACTOR_COUNT) {
  throw new Error('Production factor manifest must contain exactly 20 unique factor identities.');
}
