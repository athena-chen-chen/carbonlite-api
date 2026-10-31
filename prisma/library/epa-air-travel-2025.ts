import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { KM_PER_MILE, type AirTravelHaulCategory } from '../../src/domain/air-travel/air-travel';

export const EPA_AIR_TRAVEL_2025_SOURCE_ID =
  'official-source-us-epa-ghg-emission-factors-hub-2025-air-travel';
export const EPA_AIR_TRAVEL_2025_SOURCE_URL =
  'https://www.epa.gov/system/files/documents/2025-01/ghg-emission-factors-hub-2025.pdf';
export const EPA_AIR_TRAVEL_2025_VERSION = '2025.1';
export const EPA_AIR_TRAVEL_GWP_AR5 = { CO2: 1, CH4: 28, N2O: 265 } as const;

type AirTravelFactorDefinition = {
  haulCategory: AirTravelHaulCategory;
  displayName: string;
  distanceBand: string;
  sourceRow: string;
  co2KgPerPassengerMile: string;
  ch4GPerPassengerMile: string;
  n2oGPerPassengerMile: string;
  derivedKgCo2ePerPassengerMile: string;
  factorKgCo2ePerPassengerKm: string;
};

export const EPA_AIR_TRAVEL_2025_DEFINITIONS = [
  {
    haulCategory: 'SHORT',
    displayName: 'Air travel - EPA short haul - 2025',
    distanceBand: '< 300 one-way passenger-route miles',
    sourceRow: 'Air Travel - Short Haul (< 300 miles)',
    co2KgPerPassengerMile: '0.207',
    ch4GPerPassengerMile: '0.0064',
    n2oGPerPassengerMile: '0.0066',
    derivedKgCo2ePerPassengerMile: '0.2089282',
    factorKgCo2ePerPassengerKm: '0.1298219647',
  },
  {
    haulCategory: 'MEDIUM',
    displayName: 'Air travel - EPA medium haul - 2025',
    distanceBand: '>= 300 and < 2300 one-way passenger-route miles',
    sourceRow: 'Air Travel - Medium Haul (>= 300 miles, < 2300 miles)',
    co2KgPerPassengerMile: '0.129',
    ch4GPerPassengerMile: '0.0006',
    n2oGPerPassengerMile: '0.0041',
    derivedKgCo2ePerPassengerMile: '0.1301033',
    factorKgCo2ePerPassengerKm: '0.0808424426',
  },
  {
    haulCategory: 'LONG',
    displayName: 'Air travel - EPA long haul - 2025',
    distanceBand: '>= 2300 one-way passenger-route miles',
    sourceRow: 'Air Travel - Long Haul (>= 2300 miles)',
    co2KgPerPassengerMile: '0.163',
    ch4GPerPassengerMile: '0.0006',
    n2oGPerPassengerMile: '0.0052',
    derivedKgCo2ePerPassengerMile: '0.1643948',
    factorKgCo2ePerPassengerKm: '0.1021501929',
  },
] as const satisfies readonly AirTravelFactorDefinition[];

const REVIEWED_BY = 'CarbonLite paid-pilot methodology review';
const METHODOLOGY =
  'Direct GHG CO2e per passenger-mile = CO2 kg + (CH4 g / 1000 × 28) + (N2O g / 1000 × 265); divide by exactly 1.609344 km/mile for passenger-km.';
const BOUNDARY_NOTES =
  'Combustion/direct GHG only. Aviation non-CO2 effects and radiative forcing are excluded. Well-to-tank emissions are excluded/deferred. CarbonLite applies no additional 8% distance uplift. EPA is a U.S. methodology used as a North American paid-pilot proxy, not a Canadian official factor.';

function factorId(definition: AirTravelFactorDefinition): string {
  return `factor_${createHash('md5')
    .update(`AIR_TRAVEL|${definition.displayName}|passenger-km`)
    .digest('hex')}`;
}

export function deriveEpaAirTravelFactor(definition: AirTravelFactorDefinition) {
  const kgCo2ePerPassengerMile =
    Number(definition.co2KgPerPassengerMile) * EPA_AIR_TRAVEL_GWP_AR5.CO2 +
    Number(definition.ch4GPerPassengerMile) / 1000 * EPA_AIR_TRAVEL_GWP_AR5.CH4 +
    Number(definition.n2oGPerPassengerMile) / 1000 * EPA_AIR_TRAVEL_GWP_AR5.N2O;
  return {
    kgCo2ePerPassengerMile,
    kgCo2ePerPassengerKm: kgCo2ePerPassengerMile / KM_PER_MILE,
  };
}

export const EPA_AIR_TRAVEL_2025_FACTOR_IDS = Object.fromEntries(
  EPA_AIR_TRAVEL_2025_DEFINITIONS.map((definition) => [definition.haulCategory, factorId(definition)]),
) as Record<AirTravelHaulCategory, string>;

export const epaAirTravel2025Source = {
  sourceAuthority: 'U.S. Environmental Protection Agency',
  sourceShortName: 'U.S. EPA',
  sourceDocument: '2025 GHG Emission Factors Hub',
  sourceVersion: 'January 2025 annual update',
  sourceYear: 2025,
  sourceUrl: EPA_AIR_TRAVEL_2025_SOURCE_URL,
  page: 'Table 10',
  sourcePage: 'Table 10',
  tableReference: 'Table 10 — Scope 3 Category 6: Business Travel and Category 7: Employee Commuting',
  sourceTable: 'Table 10',
  publishedDate: new Date('2025-01-01T00:00:00.000Z'),
  country: 'United States',
  jurisdictionRegion: 'North America proxy',
  publisherType: 'GOVERNMENT',
  description: 'Official U.S. EPA organizational GHG inventory factors for business-travel air passenger-miles.',
  notes: BOUNDARY_NOTES,
  isOfficial: true,
  isActive: true,
} satisfies Prisma.FactorSourceCreateWithoutVersionsInput;

function methodologyProvenance(definition: AirTravelFactorDefinition) {
  return {
    methodologyDocument: '2025 GHG Emission Factors Hub',
    methodologyVersion: 'January 2025 annual update',
    methodologyMethod: METHODOLOGY,
    methodologySection: 'Table 10 — Scope 3 Category 6: Business Travel',
    methodologyLevel: 'U.S. EPA methodology used as a North American paid-pilot proxy',
    quantityBasis: 'PASSENGER_DISTANCE',
    inventoryCategory: 'Scope 3 Category 6 — Business Travel / Air Travel',
    sourceVersion: 'January 2025 annual update',
    publishedDate: '2025-01',
    factorYear: 2025,
    factorVersion: EPA_AIR_TRAVEL_2025_VERSION,
    sourceTable: 'Table 10',
    sourceRow: definition.sourceRow,
    sourceUnit: 'passenger-mile',
    haulCategory: definition.haulCategory,
    haulClassificationBasis: 'SERVER_DERIVED_ONE_WAY_ROUTE_MILES',
    distanceBand: definition.distanceBand,
    componentFactorsPerPassengerMile: {
      CO2: { value: definition.co2KgPerPassengerMile, unit: 'kg' },
      CH4: { value: definition.ch4GPerPassengerMile, unit: 'g' },
      N2O: { value: definition.n2oGPerPassengerMile, unit: 'g' },
    },
    gwpSource: 'IPCC Fifth Assessment Report (AR5), as used by the EPA 2025 Hub',
    gwpVersion: 'AR5 100-year: CO2=1, CH4=28, N2O=265',
    gwp100: EPA_AIR_TRAVEL_GWP_AR5,
    derivedKgCo2ePerPassengerMile: definition.derivedKgCo2ePerPassengerMile,
    distanceConversion: { milesToKm: String(KM_PER_MILE), formula: 'kgCO2e/passenger-mile ÷ 1.609344' },
    derivedKgCo2ePerPassengerKm: definition.factorKgCo2ePerPassengerKm,
    emissionsBoundary: 'COMBUSTION_DIRECT_GHG_ONLY',
    aviationNonCo2AndRadiativeForcingIncluded: false,
    wellToTankIncluded: false,
    carbonLiteAdditionalDistanceUpliftPercent: 0,
    cabinClassApplied: false,
    geographyApplicability: 'North America paid-pilot proxy',
    canadianOfficialFactor: false,
    limitations: BOUNDARY_NOTES,
  };
}

function factorRecord(definition: AirTravelFactorDefinition) {
  return {
    activityType: 'AIR_TRAVEL',
    displayName: definition.displayName,
    category: 'TRANSPORT',
    scope: 'Scope 3',
    description: `${definition.haulCategory} haul business air travel. ${BOUNDARY_NOTES}`,
    isSystem: true,
    isActive: true,
  } satisfies Prisma.FactorCreateWithoutVersionsInput;
}

function versionRecord(definition: AirTravelFactorDefinition) {
  const provenance = methodologyProvenance(definition);
  return {
    factorId: factorId(definition),
    version: EPA_AIR_TRAVEL_2025_VERSION,
    factorValue: new Prisma.Decimal(definition.factorKgCo2ePerPassengerKm),
    inputUnit: 'passenger-km',
    resultUnit: 'kgCO2e',
    jurisdictionCountry: 'Canada',
    jurisdictionRegion: 'Canada',
    factorYear: 2025,
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveTo: new Date('2025-12-31T23:59:59.999Z'),
    status: 'VERIFIED',
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    methodology: METHODOLOGY,
    verificationStatus: 'VERIFIED',
    verified: true,
    reviewedBy: REVIEWED_BY,
    reviewedAt: new Date('2026-10-30T00:00:00.000Z'),
    reviewNotes: `${definition.sourceRow}: ${METHODOLOGY} ${BOUNDARY_NOTES}`,
    approvalSource: 'U.S. EPA 2025 GHG Emission Factors Hub, Table 10',
    sourceId: EPA_AIR_TRAVEL_2025_SOURCE_ID,
    sourcePage: 'Table 10',
    sourceSection: 'Scope 3 Category 6: Business Travel',
    sourceTable: 'Table 10',
    sourceRow: definition.sourceRow,
    sourceColumn: 'CO2 Factor, CH4 Factor, N2O Factor',
    citationText: `U.S. EPA, 2025 GHG Emission Factors Hub, Table 10, ${definition.sourceRow}.`,
    notes: BOUNDARY_NOTES,
    applicability: 'CORPORATE_INVENTORY',
    emissionBasis: 'DIRECT_CO2E',
    methodologyProvenance: provenance,
  } satisfies Prisma.FactorVersionUncheckedCreateInput;
}

function legacyProjection(definition: AirTravelFactorDefinition) {
  const version = versionRecord(definition);
  return {
    organizationId: null,
    name: definition.displayName,
    type: 'EMISSION',
    activityType: 'AIR_TRAVEL',
    country: 'Canada',
    region: 'Canada',
    jurisdiction: 'Canada',
    unit: 'passenger-km',
    factorValue: version.factorValue,
    resultUnit: 'kgCO2e',
    sourceName: epaAirTravel2025Source.sourceAuthority,
    sourceAuthority: epaAirTravel2025Source.sourceAuthority,
    sourceDocument: epaAirTravel2025Source.sourceDocument,
    sourceReference: `Table 10; ${definition.sourceRow}`,
    sourceUrl: EPA_AIR_TRAVEL_2025_SOURCE_URL,
    sourceYear: 2025,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    methodology: METHODOLOGY,
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    verificationStatus: 'VERIFIED',
    verified: true,
    notes: BOUNDARY_NOTES,
    applicability: 'CORPORATE_INVENTORY',
    emissionBasis: 'DIRECT_CO2E',
    methodologyProvenance: methodologyProvenance(definition),
    isSystemDefault: true,
    isDefault: true,
  } satisfies Prisma.ConversionFactorUncheckedCreateInput;
}

export const EPA_AIR_TRAVEL_2025_PACK = EPA_AIR_TRAVEL_2025_DEFINITIONS.map((definition) => ({
  definition,
  factorId: factorId(definition),
  factor: factorRecord(definition),
  version: versionRecord(definition),
  legacy: legacyProjection(definition),
}));

export async function seedEpaAirTravel2025(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const names = EPA_AIR_TRAVEL_2025_PACK.map((entry) => entry.factor.displayName);
    const [sameNames, sameLegacyNames] = await Promise.all([
      tx.factor.findMany({ where: { displayName: { in: names } }, select: { id: true, displayName: true } }),
      tx.conversionFactor.findMany({ where: { name: { in: names } }, select: { id: true, name: true } }),
    ]);
    for (const entry of EPA_AIR_TRAVEL_2025_PACK) {
      if (sameNames.some((record) => record.displayName === entry.factor.displayName && record.id !== entry.factorId) ||
          sameLegacyNames.some((record) => record.name === entry.factor.displayName && record.id !== entry.factorId)) {
        throw new Error(`A different record already uses the production factor name: ${entry.factor.displayName}`);
      }
    }

    await tx.factorSource.upsert({
      where: { id: EPA_AIR_TRAVEL_2025_SOURCE_ID },
      update: {},
      create: { id: EPA_AIR_TRAVEL_2025_SOURCE_ID, ...epaAirTravel2025Source },
    });
    const factors = [];
    for (const entry of EPA_AIR_TRAVEL_2025_PACK) {
      await tx.factor.upsert({ where: { id: entry.factorId }, update: {}, create: { id: entry.factorId, ...entry.factor } });
      const version = await tx.factorVersion.upsert({
        where: { factorId_version: { factorId: entry.factorId, version: EPA_AIR_TRAVEL_2025_VERSION } },
        update: { factorValue: entry.version.factorValue },
        create: entry.version,
      });
      await tx.conversionFactor.upsert({
        where: { id: entry.factorId },
        update: { factorValue: entry.legacy.factorValue },
        create: { id: entry.factorId, ...entry.legacy },
      });
      factors.push({ haulCategory: entry.definition.haulCategory, factorId: entry.factorId, factorVersionId: version.id });
    }
    return { sourceId: EPA_AIR_TRAVEL_2025_SOURCE_ID, factors };
  });
}

export function assertEpaAirTravelDevelopmentTarget(
  env: Record<string, string | undefined>,
  confirmedEndpoint: string | undefined,
) {
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch {
    throw new Error('Invalid development database configuration.');
  }
  const endpoint = url.hostname.split('.')[0].replace(/-pooler$/, '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname.endsWith('.neon.tech') ||
      url.hostname !== env.NEON_DEVELOPMENT_HOST ||
      confirmedEndpoint !== endpoint ||
      !confirmedEndpoint?.startsWith('ep-') ||
      url.searchParams.get('sslmode') !== 'require' ||
      url.searchParams.has('host') ||
      url.searchParams.has('hostaddr') ||
      env.NODE_ENV !== 'development' ||
      env.APP_ENV !== 'local' ||
      /prod|production|staging|stage|main/i.test(url.hostname + url.pathname)) {
    throw new Error('Refusing data load: confirm the configured endpoint belongs to Neon development and pass --confirmed-development-endpoint=<endpoint-id>.');
  }
}
