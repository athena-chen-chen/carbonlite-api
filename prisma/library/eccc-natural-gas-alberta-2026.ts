import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export const ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID =
  'official-source-eccc-natural-gas-alberta-2026';
export const ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_URL =
  'https://www.canada.ca/en/environment-climate-change/services/climate-change/pricing-pollution-how-it-will-work/output-based-pricing-system/federal-greenhouse-gas-offset-system/emission-factors-reference-values.html';
export const ECCC_NATURAL_GAS_ALBERTA_2026_VERSION = '2026.1';
export const ECCC_NATURAL_GAS_ALBERTA_2026_VALUE = '51.3756446991404';

const DISPLAY_NAME = 'Natural gas combustion - Alberta - 2026';
const SOURCE_VERSION = '4.0 (September 2026)';
const SOURCE_TABLES = 'Tables 1.3, 2.3 and 8';
const REVIEWED_BY = 'CarbonLite paid-pilot methodology review';
const METHODOLOGY =
  'Direct combustion CO2e per m3 = CO2 + (CH4 x 28) + (N2O x 265); divide by the ECCC 38.39 MJ/m3 HHV. The resulting g/MJ is numerically kg/GJ.';

function factorId(): string {
  return `factor_${createHash('md5')
    .update(`NATURAL_GAS|${DISPLAY_NAME}|GJ`)
    .digest('hex')}`;
}

export const ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID = factorId();

export const ecccNaturalGasAlberta2026Source = {
  sourceAuthority: 'Environment and Climate Change Canada',
  sourceShortName: 'ECCC',
  sourceDocument: 'Emission factors and reference values',
  sourceVersion: SOURCE_VERSION,
  sourceYear: 2026,
  sourceUrl: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_URL,
  page: 'Sections 4.1 and 4.5',
  sourcePage: 'Sections 4.1 and 4.5',
  tableReference: SOURCE_TABLES,
  sourceTable: SOURCE_TABLES,
  publishedDate: new Date('2026-09-09T00:00:00.000Z'),
  country: 'Canada',
  jurisdictionRegion: 'Alberta',
  publisherType: 'GOVERNMENT',
  description:
    'Official ECCC natural-gas combustion components applicable to 2026 and source-consistent HHV.',
  notes:
    'Alberta marketable natural gas CO2 from Table 1.3; commercial/institutional CH4 and N2O from Table 2.3; gaseous natural-gas HHV from Table 8.',
  isOfficial: true,
  isActive: true,
} satisfies Prisma.FactorSourceCreateWithoutVersionsInput;

export const ecccNaturalGasAlberta2026Factor = {
  activityType: 'NATURAL_GAS',
  displayName: DISPLAY_NAME,
  category: 'FUEL',
  scope: 'Scope 1',
  description:
    'Alberta commercial/institutional stationary combustion of utility-supplied marketable natural gas, calendar year 2026.',
  isSystem: true,
  isActive: true,
} satisfies Prisma.FactorCreateWithoutVersionsInput;

const methodologyProvenance = {
  methodologyDocument: 'Emission factors and reference values',
  methodologyVersion: SOURCE_VERSION,
  methodologyMethod: METHODOLOGY,
  methodologySection: '4.1 Fossil fuel combustion; 4.5 Displacement of fossil fuels',
  methodologyLevel: 'Alberta marketable natural gas; commercial/institutional combustion',
  quantityBasis: 'ENERGY_HHV',
  gwpSource: 'ECCC Global warming potentials; IPCC Fifth Assessment Report',
  gwpVersion: 'AR5 100-year: CO2=1, CH4=28, N2O=265',
  sourceVersion: SOURCE_VERSION,
  publishedDate: '2026-09-09',
  factorYear: 2026,
  factorVersion: ECCC_NATURAL_GAS_ALBERTA_2026_VERSION,
  sourceTable: SOURCE_TABLES,
  fuelType: 'Marketable natural gas',
  combustionSector: 'Commercial/Institutional',
  componentFactorsGPerM3: {
    CO2: '1962',
    CH4: '0.037',
    N2O: '0.035',
  },
  componentProvenance: {
    CO2: 'Table 1.3, Alberta marketable natural gas',
    CH4: 'Table 2.3, Residential / Construction / Commercial / Institutional / Agriculture',
    N2O: 'Table 2.3, Residential / Construction / Commercial / Institutional / Agriculture',
  },
  gwp100: { CO2: 1, CH4: 28, N2O: 265 },
  energyConversion: {
    value: '38.39',
    unit: 'MJ/m3',
    basis: 'HHV',
    source: 'Table 8, Natural gas, gaseous',
    standardConditions: '15 C and 101.325 kPa',
  },
  derivedFactorKgCO2ePerGJ: ECCC_NATURAL_GAS_ALBERTA_2026_VALUE,
};

const reviewNotes =
  '(1962 + 0.037 x 28 + 0.035 x 265) / 38.39 = 51.3756446991404 kgCO2e/GJ. This uses ECCC HHV, not the generic CRA 26.853 m3/GJ conversion. The separate 49.44 kgCO2e/GJ projection reference remains reference-only.';

export const ecccNaturalGasAlberta2026Version = {
  factorId: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
  version: ECCC_NATURAL_GAS_ALBERTA_2026_VERSION,
  factorValue: new Prisma.Decimal(ECCC_NATURAL_GAS_ALBERTA_2026_VALUE),
  inputUnit: 'GJ',
  resultUnit: 'kgCO2e',
  jurisdictionCountry: 'Canada',
  jurisdictionRegion: 'Alberta',
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
  reviewNotes,
  approvalSource: `ECCC Emission factors and reference values ${SOURCE_VERSION}, ${SOURCE_TABLES}`,
  sourceId: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
  sourcePage: 'Sections 4.1 and 4.5',
  sourceSection: '4.1 Fossil fuel combustion; 4.5 Displacement of fossil fuels',
  sourceTable: SOURCE_TABLES,
  sourceRow: 'Alberta marketable gas; Commercial/Institutional; Natural gas, gaseous',
  sourceColumn: 'CO2, CH4, N2O, HHV',
  citationText: `ECCC, Emission factors and reference values, ${SOURCE_VERSION}, ${SOURCE_TABLES}.`,
  notes: reviewNotes,
  applicability: 'CORPORATE_INVENTORY',
  emissionBasis: 'DIRECT_CO2E',
  methodologyProvenance,
} satisfies Prisma.FactorVersionUncheckedCreateInput;

export const ecccNaturalGasAlberta2026Legacy = {
  organizationId: null,
  name: DISPLAY_NAME,
  type: 'EMISSION',
  activityType: 'NATURAL_GAS',
  country: 'Canada',
  region: 'Alberta',
  jurisdiction: 'Alberta, Canada',
  unit: 'GJ',
  factorValue: new Prisma.Decimal(ECCC_NATURAL_GAS_ALBERTA_2026_VALUE),
  resultUnit: 'kgCO2e',
  sourceName: ecccNaturalGasAlberta2026Source.sourceAuthority,
  sourceAuthority: ecccNaturalGasAlberta2026Source.sourceAuthority,
  sourceDocument: ecccNaturalGasAlberta2026Source.sourceDocument,
  sourceReference: SOURCE_TABLES,
  sourceUrl: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_URL,
  sourceYear: 2026,
  effectiveFrom: ecccNaturalGasAlberta2026Version.effectiveFrom,
  effectiveTo: ecccNaturalGasAlberta2026Version.effectiveTo,
  methodology: METHODOLOGY,
  confidenceLevel: 'OFFICIAL_GOVERNMENT',
  verificationStatus: 'VERIFIED',
  verified: true,
  notes: reviewNotes,
  applicability: 'CORPORATE_INVENTORY',
  emissionBasis: 'DIRECT_CO2E',
  methodologyProvenance,
  isSystemDefault: true,
  isDefault: true,
} satisfies Prisma.ConversionFactorUncheckedCreateInput;

/** Adds the reviewed identity; reruns restore only its authoritative numeric value. */
export async function seedEcccNaturalGasAlberta2026(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const [sameName, sameLegacyName] = await Promise.all([
      tx.factor.findFirst({ where: { displayName: DISPLAY_NAME }, select: { id: true } }),
      tx.conversionFactor.findFirst({ where: { name: DISPLAY_NAME }, select: { id: true } }),
    ]);
    if ((sameName && sameName.id !== ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID) ||
        (sameLegacyName && sameLegacyName.id !== ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID)) {
      throw new Error(`A different record already uses the production factor name: ${DISPLAY_NAME}`);
    }

    await tx.factorSource.upsert({
      where: { id: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID },
      update: {},
      create: { id: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID, ...ecccNaturalGasAlberta2026Source },
    });
    await tx.factor.upsert({
      where: { id: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID },
      update: {},
      create: { id: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID, ...ecccNaturalGasAlberta2026Factor },
    });
    const version = await tx.factorVersion.upsert({
      where: {
        factorId_version: {
          factorId: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
          version: ECCC_NATURAL_GAS_ALBERTA_2026_VERSION,
        },
      },
      update: { factorValue: ecccNaturalGasAlberta2026Version.factorValue },
      create: ecccNaturalGasAlberta2026Version,
    });
    await tx.conversionFactor.upsert({
      where: { id: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID },
      update: { factorValue: ecccNaturalGasAlberta2026Legacy.factorValue },
      create: { id: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID, ...ecccNaturalGasAlberta2026Legacy },
    });
    return {
      sourceId: ECCC_NATURAL_GAS_ALBERTA_2026_SOURCE_ID,
      factorId: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
      factorVersionId: version.id,
    };
  });
}

export function assertNaturalGasDevelopmentTarget(
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
