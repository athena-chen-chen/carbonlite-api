import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export const ECCC_REFINED_PETROLEUM_2026_SOURCE_ID =
  'official-source-eccc-emission-factors-reference-values-4-0-2026';
export const ECCC_REFINED_PETROLEUM_2026_SOURCE_URL =
  'https://www.canada.ca/en/environment-climate-change/services/climate-change/pricing-pollution-how-it-will-work/output-based-pricing-system/federal-greenhouse-gas-offset-system/emission-factors-reference-values.html';
export const ECCC_REFINED_PETROLEUM_2026_TABLE =
  'Table 4.3 — Emission factors for refined petroleum products for 2026';
export const ECCC_REFINED_PETROLEUM_2026_VERSION = '2026.1';
export const ECCC_REFINED_PETROLEUM_2026_REVIEWED_AT = new Date(
  '2026-10-29T00:00:00.000Z',
);

const SOURCE_VERSION = '4.0 (September 2026)';
const REVIEWED_BY = 'CarbonLite paid-pilot methodology review';
const APPROVAL_SOURCE =
  'ECCC Emission factors and reference values v4.0, Table 4.3; Greenhouse Gas Pollution Pricing Act, Schedule 3';
const GWP_SOURCE = 'Greenhouse Gas Pollution Pricing Act, Schedule 3';
const GWP_VERSION = 'Act current to 2026-09-30: CO2=1, CH4=28, N2O=265';
const METHODOLOGY =
  'Direct combustion CO2e = CO2 + (CH4 × 28) + (N2O × 265); source grams per litre converted to kilograms per litre by dividing by 1000.';

type FuelDefinition = {
  activityType: 'GASOLINE' | 'DIESEL';
  displayName: string;
  sourceRow: string;
  co2GPerL: string;
  ch4GPerL: string;
  n2oGPerL: string;
  factorKgCo2ePerL: string;
};

const fuelDefinitions = {
  gasoline: {
    activityType: 'GASOLINE',
    displayName: 'Motor gasoline combustion - Canada - 2026',
    sourceRow: 'Motor Gasoline',
    co2GPerL: '2307',
    ch4GPerL: '0.100',
    n2oGPerL: '0.02',
    factorKgCo2ePerL: '2.3151',
  },
  diesel: {
    activityType: 'DIESEL',
    displayName: 'Diesel combustion - Canada - 2026',
    sourceRow: 'Diesel - Refineries and Others',
    co2GPerL: '2681',
    ch4GPerL: '0.078',
    n2oGPerL: '0.022',
    factorKgCo2ePerL: '2.689014',
  },
} as const satisfies Record<string, FuelDefinition>;

function factorId(definition: FuelDefinition): string {
  return `factor_${createHash('md5')
    .update(`${definition.activityType}|${definition.displayName}|L`)
    .digest('hex')}`;
}

export const ECCC_GASOLINE_2026_FACTOR_ID = factorId(fuelDefinitions.gasoline);
export const ECCC_DIESEL_2026_FACTOR_ID = factorId(fuelDefinitions.diesel);

const sourceNotes =
  'Table 4.3 is applicable to calendar-year 2026 and cites ECCC (2025), NIR 1990-2023, Part 2, Table A6.1-6. CarbonLite aggregates the published CO2, CH4 and N2O component factors using the statutory Schedule 3 GWPs in force for 2026.';

export const ecccRefinedPetroleum2026Source = {
  sourceAuthority: 'Environment and Climate Change Canada',
  sourceShortName: 'ECCC',
  sourceDocument: 'Emission factors and reference values',
  sourceVersion: SOURCE_VERSION,
  sourceYear: 2026,
  sourceUrl: ECCC_REFINED_PETROLEUM_2026_SOURCE_URL,
  page: 'Section 4.1',
  sourcePage: 'Section 4.1',
  tableReference: ECCC_REFINED_PETROLEUM_2026_TABLE,
  sourceTable: ECCC_REFINED_PETROLEUM_2026_TABLE,
  publishedDate: new Date('2026-09-09T00:00:00.000Z'),
  country: 'Canada',
  jurisdictionRegion: 'Canada',
  publisherType: 'GOVERNMENT',
  description:
    'Official ECCC refined-petroleum combustion component factors applicable to 2026.',
  notes: sourceNotes,
  isOfficial: true,
  isActive: true,
} satisfies Prisma.FactorSourceCreateWithoutVersionsInput;

function methodologyProvenance(definition: FuelDefinition) {
  return {
    methodologyDocument: 'Emission factors and reference values',
    methodologyVersion: SOURCE_VERSION,
    methodologyMethod: METHODOLOGY,
    methodologySection: ECCC_REFINED_PETROLEUM_2026_TABLE,
    methodologyLevel: 'Canada national direct-combustion factor',
    quantityBasis: 'VOLUME',
    gwpSource: GWP_SOURCE,
    gwpVersion: GWP_VERSION,
    sourceVersion: SOURCE_VERSION,
    publishedDate: '2026-09-09',
    factorYear: 2026,
    factorVersion: ECCC_REFINED_PETROLEUM_2026_VERSION,
    sourceTable: ECCC_REFINED_PETROLEUM_2026_TABLE,
    fuelType: definition.sourceRow,
    nirProvenance:
      'ECCC (2025), NIR 1990-2023, Part 2, Table A6.1-6, Emission Factors for Refined Petroleum Products',
    componentFactorsGPerL: {
      CO2: definition.co2GPerL,
      CH4: definition.ch4GPerL,
      N2O: definition.n2oGPerL,
    },
    gwp100: { CO2: 1, CH4: 28, N2O: 265 },
    derivedFactorKgCO2ePerL: definition.factorKgCo2ePerL,
  };
}

function reviewNotes(definition: FuelDefinition): string {
  return `${definition.sourceRow}: (${definition.co2GPerL} + ${definition.ch4GPerL} × 28 + ${definition.n2oGPerL} × 265) / 1000 = ${definition.factorKgCo2ePerL} kgCO2e/L. Source applicability is calendar year 2026.`;
}

function factorRecord(definition: FuelDefinition) {
  return {
    activityType: definition.activityType,
    displayName: definition.displayName,
    category: 'FUEL',
    scope: 'Scope 1',
    description: reviewNotes(definition),
    isSystem: true,
    isActive: true,
  } satisfies Prisma.FactorCreateWithoutVersionsInput;
}

function versionRecord(definition: FuelDefinition) {
  return {
    factorId: factorId(definition),
    version: ECCC_REFINED_PETROLEUM_2026_VERSION,
    factorValue: new Prisma.Decimal(definition.factorKgCo2ePerL),
    inputUnit: 'L',
    resultUnit: 'kgCO2e',
    jurisdictionCountry: 'Canada',
    jurisdictionRegion: 'Canada',
    factorYear: 2026,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: new Date('2026-12-31T23:59:59.999Z'),
    status: 'VERIFIED',
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    methodology: METHODOLOGY,
    verificationStatus: 'VERIFIED',
    verified: true,
    reviewedBy: REVIEWED_BY,
    reviewedAt: ECCC_REFINED_PETROLEUM_2026_REVIEWED_AT,
    reviewNotes: reviewNotes(definition),
    approvalSource: APPROVAL_SOURCE,
    sourceId: ECCC_REFINED_PETROLEUM_2026_SOURCE_ID,
    sourcePage: 'Section 4.1',
    sourceSection: '4.1 Fossil fuel combustion',
    sourceTable: ECCC_REFINED_PETROLEUM_2026_TABLE,
    sourceRow: definition.sourceRow,
    sourceColumn: 'CO2, CH4, N2O',
    citationText: `ECCC, Emission factors and reference values, ${SOURCE_VERSION}, Table 4.3, ${definition.sourceRow}.`,
    notes: sourceNotes,
    applicability: 'CORPORATE_INVENTORY',
    emissionBasis: 'DIRECT_CO2E',
    methodologyProvenance: methodologyProvenance(definition),
  } satisfies Prisma.FactorVersionUncheckedCreateInput;
}

function legacyProjection(definition: FuelDefinition) {
  const version = versionRecord(definition);
  return {
    organizationId: null,
    name: definition.displayName,
    type: 'EMISSION',
    activityType: definition.activityType,
    country: 'Canada',
    region: 'Canada',
    jurisdiction: 'Canada',
    unit: version.inputUnit,
    factorValue: version.factorValue,
    resultUnit: version.resultUnit,
    sourceName: ecccRefinedPetroleum2026Source.sourceAuthority,
    sourceAuthority: ecccRefinedPetroleum2026Source.sourceAuthority,
    sourceDocument: ecccRefinedPetroleum2026Source.sourceDocument,
    sourceReference: `${ECCC_REFINED_PETROLEUM_2026_TABLE}; ${definition.sourceRow}`,
    sourceUrl: ECCC_REFINED_PETROLEUM_2026_SOURCE_URL,
    sourceYear: 2026,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    methodology: version.methodology,
    confidenceLevel: 'OFFICIAL_GOVERNMENT',
    verificationStatus: version.verificationStatus,
    verified: true,
    notes: reviewNotes(definition),
    applicability: version.applicability,
    emissionBasis: version.emissionBasis,
    methodologyProvenance: methodologyProvenance(definition),
    isSystemDefault: true,
    isDefault: true,
  } satisfies Prisma.ConversionFactorUncheckedCreateInput;
}

export const ecccGasoline2026Factor = factorRecord(fuelDefinitions.gasoline);
export const ecccGasoline2026Version = versionRecord(fuelDefinitions.gasoline);
export const ecccGasoline2026Legacy = legacyProjection(fuelDefinitions.gasoline);
export const ecccDiesel2026Factor = factorRecord(fuelDefinitions.diesel);
export const ecccDiesel2026Version = versionRecord(fuelDefinitions.diesel);
export const ecccDiesel2026Legacy = legacyProjection(fuelDefinitions.diesel);

const pack = [
  {
    factorId: ECCC_GASOLINE_2026_FACTOR_ID,
    factor: ecccGasoline2026Factor,
    version: ecccGasoline2026Version,
    legacy: ecccGasoline2026Legacy,
  },
  {
    factorId: ECCC_DIESEL_2026_FACTOR_ID,
    factor: ecccDiesel2026Factor,
    version: ecccDiesel2026Version,
    legacy: ecccDiesel2026Legacy,
  },
] as const;

/** Adds only new identities; empty updates preserve later governance edits. */
export async function seedEcccRefinedPetroleum2026(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const names = pack.map((entry) => entry.factor.displayName);
    const [sameNames, sameLegacyNames] = await Promise.all([
      tx.factor.findMany({ where: { displayName: { in: names } }, select: { id: true, displayName: true } }),
      tx.conversionFactor.findMany({ where: { name: { in: names } }, select: { id: true, name: true } }),
    ]);
    for (const entry of pack) {
      if (sameNames.some((record) => record.displayName === entry.factor.displayName && record.id !== entry.factorId) ||
          sameLegacyNames.some((record) => record.name === entry.factor.displayName && record.id !== entry.factorId)) {
        throw new Error(`A different record already uses the production factor name: ${entry.factor.displayName}`);
      }
    }

    await tx.factorSource.upsert({
      where: { id: ECCC_REFINED_PETROLEUM_2026_SOURCE_ID },
      update: {},
      create: { id: ECCC_REFINED_PETROLEUM_2026_SOURCE_ID, ...ecccRefinedPetroleum2026Source },
    });

    const results = [];
    for (const entry of pack) {
      await tx.factor.upsert({ where: { id: entry.factorId }, update: {}, create: { id: entry.factorId, ...entry.factor } });
      const version = await tx.factorVersion.upsert({
        where: { factorId_version: { factorId: entry.factorId, version: ECCC_REFINED_PETROLEUM_2026_VERSION } },
        update: {},
        create: entry.version,
      });
      await tx.conversionFactor.upsert({ where: { id: entry.factorId }, update: {}, create: { id: entry.factorId, ...entry.legacy } });
      results.push({ factorId: entry.factorId, factorVersionId: version.id });
    }
    return { sourceId: ECCC_REFINED_PETROLEUM_2026_SOURCE_ID, factors: results };
  });
}
