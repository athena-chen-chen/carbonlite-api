import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';

export const ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID =
  'official-source-eccc-electricity-consumption-intensity-2026';
export const ECCC_ELECTRICITY_CANADA_2026_SOURCE_URL =
  'https://www.canada.ca/en/environment-climate-change/services/climate-change/pricing-pollution-how-it-will-work/output-based-pricing-system/federal-greenhouse-gas-offset-system/emission-factors-reference-values.html';
export const ECCC_ELECTRICITY_CANADA_2026_VERSION = '2026.1';

type ElectricityDefinition = {
  geography: string;
  code: string;
  gramsCo2ePerKwh: string;
};

export const ECCC_ELECTRICITY_CANADA_2026_DEFINITIONS = [
  { geography: 'British Columbia', code: 'BC', gramsCo2ePerKwh: '18' },
  { geography: 'Alberta', code: 'AB', gramsCo2ePerKwh: '438' },
  { geography: 'Saskatchewan', code: 'SK', gramsCo2ePerKwh: '631' },
  { geography: 'Manitoba', code: 'MB', gramsCo2ePerKwh: '2.5' },
  { geography: 'Ontario', code: 'ON', gramsCo2ePerKwh: '59' },
  { geography: 'Quebec', code: 'QC', gramsCo2ePerKwh: '1.9' },
  { geography: 'New Brunswick', code: 'NB', gramsCo2ePerKwh: '234' },
  { geography: 'Nova Scotia', code: 'NS', gramsCo2ePerKwh: '581' },
  { geography: 'Prince Edward Island', code: 'PE', gramsCo2ePerKwh: '234' },
  { geography: 'Newfoundland and Labrador', code: 'NL', gramsCo2ePerKwh: '17' },
  { geography: 'Yukon', code: 'YT', gramsCo2ePerKwh: '74' },
  { geography: 'Northwest Territories', code: 'NT', gramsCo2ePerKwh: '420' },
  { geography: 'Nunavut', code: 'NU', gramsCo2ePerKwh: '800' },
] as const satisfies readonly ElectricityDefinition[];

const SOURCE_VERSION = 'Version 4.0 (September 2026)';
const SOURCE_TABLE = 'Table 5.3';
const REVIEWED_BY = 'CarbonLite paid-pilot methodology review';
const METHODOLOGY =
  'CarbonLite location-based corporate Scope 2: ECCC provincial or territorial electricity consumption intensity in gCO2e/kWh divided by 1000 to kgCO2e/kWh.';

export function deriveElectricityKgCo2ePerKwh(definition: ElectricityDefinition) {
  return new Prisma.Decimal(definition.gramsCo2ePerKwh).dividedBy(1000);
}

function displayName(definition: ElectricityDefinition) {
  return `Electricity - ${definition.geography} - 2026 Location-based`;
}

function factorId(definition: ElectricityDefinition) {
  return `factor_${createHash('md5')
    .update(`ELECTRICITY|${displayName(definition)}|kWh`)
    .digest('hex')}`;
}

export const ecccElectricityCanada2026Source = {
  sourceAuthority: 'Environment and Climate Change Canada',
  sourceShortName: 'ECCC',
  sourceDocument: 'Emission factors and reference values',
  sourceVersion: SOURCE_VERSION,
  sourceYear: 2026,
  sourceUrl: ECCC_ELECTRICITY_CANADA_2026_SOURCE_URL,
  page: 'Section 4.2',
  sourcePage: 'Section 4.2',
  tableReference: SOURCE_TABLE,
  sourceTable: SOURCE_TABLE,
  publishedDate: new Date('2026-09-09T00:00:00.000Z'),
  country: 'Canada',
  jurisdictionRegion: 'Canada — provinces and territories',
  publisherType: 'GOVERNMENT',
  description:
    'Official ECCC calendar-year 2026 electricity consumption intensities reflecting electricity delivered to the consumer.',
  notes:
    'ECCC publishes Table 5.3 for the federal offset/reference-value framework. CarbonLite separately adopts the underlying consumption-intensity values for corporate location-based Scope 2; ECCC does not label the table a corporate Scope 2 standard.',
  isOfficial: true,
  isActive: true,
} satisfies Prisma.FactorSourceCreateWithoutVersionsInput;

function methodologyProvenance(definition: ElectricityDefinition) {
  const derived = deriveElectricityKgCo2ePerKwh(definition);
  return {
    methodologyDocument: 'Emission factors and reference values',
    methodologyVersion: SOURCE_VERSION,
    methodologyMethod: METHODOLOGY,
    methodologySection: '4.2 Grid electricity consumption',
    methodologyLevel: `${definition.geography} electricity consumption intensity`,
    inventoryScope: 'SCOPE_2',
    scope2AccountingMethod: 'LOCATION_BASED',
    quantityBasis: 'ELECTRICITY_CONSUMED',
    consumptionIntensityBasis: 'DELIVERED_TO_CONSUMER',
    corporateMethodologyAdoption: 'CARBONLITE_V0_1',
    ecccPublicationPurpose: 'CANADA_FEDERAL_OFFSET_REFERENCE_VALUE_FRAMEWORK',
    sourceVersion: SOURCE_VERSION,
    publishedDate: '2026-09-09',
    factorYear: 2026,
    factorVersion: ECCC_ELECTRICITY_CANADA_2026_VERSION,
    sourceTable: SOURCE_TABLE,
    sourceRow: definition.geography,
    sourceValue: definition.gramsCo2ePerKwh,
    sourceUnit: 'gCO2e/kWh',
    conversionFormula: 'gCO2e/kWh / 1000 = kgCO2e/kWh',
    derivedValue: derived.toString(),
    derivedUnit: 'kgCO2e/kWh',
    marketBasedScope2Calculated: false,
    marketBasedDisclosure:
      'Market-based Scope 2 is not calculated unless qualifying contractual data is provided.',
  };
}

function factorRecord(definition: ElectricityDefinition) {
  return {
    activityType: 'ELECTRICITY',
    displayName: displayName(definition),
    category: 'ELECTRICITY',
    scope: 'Scope 2 — Location-based',
    description: `${definition.geography} purchased grid electricity, calendar year 2026, location-based corporate Scope 2.`,
    isSystem: true,
    isActive: true,
  } satisfies Prisma.FactorCreateWithoutVersionsInput;
}

function versionRecord(definition: ElectricityDefinition) {
  const value = deriveElectricityKgCo2ePerKwh(definition);
  const provenance = methodologyProvenance(definition);
  return {
    factorId: factorId(definition),
    version: ECCC_ELECTRICITY_CANADA_2026_VERSION,
    factorValue: value,
    inputUnit: 'kWh',
    resultUnit: 'kgCO2e',
    jurisdictionCountry: 'Canada',
    jurisdictionRegion: definition.geography,
    factorYear: 2026,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: new Date('2026-12-31T23:59:59.999Z'),
    status: 'VERIFIED',
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    methodology: METHODOLOGY,
    verificationStatus: 'VERIFIED',
    verified: true,
    reviewedBy: REVIEWED_BY,
    reviewedAt: new Date('2026-10-30T00:00:00.000Z'),
    reviewNotes: `${definition.gramsCo2ePerKwh} gCO2e/kWh / 1000 = ${value.toString()} kgCO2e/kWh. CarbonLite adoption is location-based corporate Scope 2 only.`,
    approvalSource: `CarbonLite v0.1 methodology adoption; ECCC ${SOURCE_VERSION}, ${SOURCE_TABLE}`,
    sourceId: ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID,
    sourcePage: 'Section 4.2',
    sourceSection: '4.2 Grid electricity consumption',
    sourceTable: SOURCE_TABLE,
    sourceRow: definition.geography,
    sourceColumn: 'Consumption intensity',
    citationText: `ECCC, Emission factors and reference values, ${SOURCE_VERSION}, ${SOURCE_TABLE}, ${definition.geography}.`,
    notes: 'Scope 2 — Location-based. Market-based Scope 2 is not calculated without qualifying contractual data.',
    applicability: 'CORPORATE_INVENTORY',
    emissionBasis: 'DIRECT_CO2E',
    methodologyProvenance: provenance,
  } satisfies Prisma.FactorVersionUncheckedCreateInput;
}

function legacyProjection(definition: ElectricityDefinition) {
  const version = versionRecord(definition);
  return {
    organizationId: null,
    name: displayName(definition),
    type: 'EMISSION',
    activityType: 'ELECTRICITY',
    country: 'Canada',
    region: definition.geography,
    jurisdiction: `${definition.geography}, Canada`,
    unit: 'kWh',
    factorValue: version.factorValue,
    resultUnit: 'kgCO2e',
    sourceName: ecccElectricityCanada2026Source.sourceAuthority,
    sourceAuthority: ecccElectricityCanada2026Source.sourceAuthority,
    sourceDocument: ecccElectricityCanada2026Source.sourceDocument,
    sourceReference: `${SOURCE_TABLE}; ${definition.geography}`,
    sourceUrl: ECCC_ELECTRICITY_CANADA_2026_SOURCE_URL,
    sourceYear: 2026,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    methodology: METHODOLOGY,
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    verificationStatus: 'VERIFIED',
    verified: true,
    notes: version.notes,
    applicability: 'CORPORATE_INVENTORY',
    emissionBasis: 'DIRECT_CO2E',
    methodologyProvenance: methodologyProvenance(definition),
    isSystemDefault: true,
    isDefault: true,
  } satisfies Prisma.ConversionFactorUncheckedCreateInput;
}

export const ECCC_ELECTRICITY_CANADA_2026_PACK =
  ECCC_ELECTRICITY_CANADA_2026_DEFINITIONS.map((definition) => ({
    definition,
    factorId: factorId(definition),
    factor: factorRecord(definition),
    version: versionRecord(definition),
    legacy: legacyProjection(definition),
  }));

/** Adds the reviewed pack without rewriting historical factors or snapshots. */
export async function seedEcccElectricityCanada2026(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const names = ECCC_ELECTRICITY_CANADA_2026_PACK.map((entry) => entry.factor.displayName);
    const [sameNames, sameLegacyNames, existingVersions, existingLegacy] = await Promise.all([
      tx.factor.findMany({ where: { displayName: { in: names } }, select: { id: true, displayName: true } }),
      tx.conversionFactor.findMany({ where: { name: { in: names } }, select: { id: true, name: true } }),
      tx.factorVersion.findMany({
        where: { factorYear: 2026, factor: { activityType: 'ELECTRICITY', isActive: true } },
        include: { factor: true, source: true },
      }),
      tx.conversionFactor.findMany({
        where: { activityType: 'ELECTRICITY', sourceYear: 2026, isSystemDefault: true },
      }),
    ]);

    for (const entry of ECCC_ELECTRICITY_CANADA_2026_PACK) {
      if (sameNames.some((record) => record.displayName === entry.factor.displayName && record.id !== entry.factorId) ||
          sameLegacyNames.some((record) => record.name === entry.factor.displayName && record.id !== entry.factorId)) {
        throw new Error(`A different record already uses the production factor name: ${entry.factor.displayName}`);
      }
      const eligibleIds = new Set([
        ...existingVersions
          .filter(isInventoryFactorEligible)
          .filter((record) => record.jurisdictionRegion === entry.definition.geography)
          .map((record) => record.factorId),
        ...existingLegacy
          .filter(isInventoryFactorEligible)
          .filter((record) => record.region === entry.definition.geography || record.jurisdiction === `${entry.definition.geography}, Canada`)
          .map((record) => record.id),
      ]);
      if ([...eligibleIds].some((id) => id !== entry.factorId)) {
        throw new Error(`Another eligible 2026 location-based electricity factor exists for ${entry.definition.geography}.`);
      }
    }

    await tx.factorSource.upsert({
      where: { id: ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID },
      update: {},
      create: { id: ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID, ...ecccElectricityCanada2026Source },
    });

    const factorVersionIds: string[] = [];
    for (const entry of ECCC_ELECTRICITY_CANADA_2026_PACK) {
      await tx.factor.upsert({
        where: { id: entry.factorId }, update: {}, create: { id: entry.factorId, ...entry.factor },
      });
      const version = await tx.factorVersion.upsert({
        where: { factorId_version: { factorId: entry.factorId, version: ECCC_ELECTRICITY_CANADA_2026_VERSION } },
        update: { factorValue: entry.version.factorValue },
        create: entry.version,
      });
      await tx.conversionFactor.upsert({
        where: { id: entry.factorId },
        update: { factorValue: entry.legacy.factorValue },
        create: { id: entry.factorId, ...entry.legacy },
      });
      factorVersionIds.push(version.id);
    }
    return {
      sourceId: ECCC_ELECTRICITY_CANADA_2026_SOURCE_ID,
      factorIds: ECCC_ELECTRICITY_CANADA_2026_PACK.map((entry) => entry.factorId),
      factorVersionIds,
      count: ECCC_ELECTRICITY_CANADA_2026_PACK.length,
    };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export function assertElectricityDevelopmentTarget(
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
