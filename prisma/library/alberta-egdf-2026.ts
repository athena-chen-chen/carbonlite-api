import { Prisma, PrismaClient } from '@prisma/client';

// Existing library migration convention: factor_ + md5(activity|name|inputUnit).
export const ALBERTA_EGDF_FACTOR_ID = 'factor_c858db65a889f4f6031e38658341f45f';
export const ALBERTA_EGDF_SOURCE_ID = 'official-source-alberta-carbon-offset-emission-factors-handbook-3-2';
export const ALBERTA_EGDF_VERSION = '2026.1';
export const ALBERTA_EGDF_NAME = 'Alberta Electricity Grid Displacement - Renewable - 2026';
export const ALBERTA_EGDF_TABLE = 'Table 1 — Electricity Grid Displacement Factors';
export const ALBERTA_EGDF_SOURCE_URL = 'https://open.alberta.ca/dataset/f2109d83-2153-4481-a8b8-b00178e53999/resource/316751cf-0387-4acd-8e03-cd134bc4a5b2/download/epa-carbon-offset-emission-factors-handbook-v3-2-2025-08.pdf';

// Original source units are supported directly: no normalization or rounding.
const notes = 'Electricity grid displacement with renewable generation. Original source: 0.4303 tCO2e/MWh, 2026 vintage, Handbook version 3.2. Alberta emission offset project reference only; excluded from ordinary corporate purchased-electricity inventory. No end-user offset workflow or regulatory compliance certification is implied.';
const provenance = {
  methodologyDocument: 'Carbon Offset Emission Factors Handbook',
  methodologyVersion: '3.2',
  methodologyMethod: 'Grid Displacement',
  methodologySection: ALBERTA_EGDF_TABLE,
};

export const albertaEgdfSource = {
  sourceAuthority: 'Alberta Environment and Protected Areas',
  sourceShortName: 'AEPA',
  sourceDocument: 'Carbon Offset Emission Factors Handbook',
  sourceVersion: '3.2',
  sourceYear: 2025,
  publishedDate: new Date('2025-08-20T00:00:00.000Z'),
  sourceUrl: ALBERTA_EGDF_SOURCE_URL,
  page: '5',
  sourcePage: '5',
  tableReference: ALBERTA_EGDF_TABLE,
  sourceTable: ALBERTA_EGDF_TABLE,
  country: 'Canada',
  jurisdictionRegion: 'Alberta',
  publisherType: 'GOVERNMENT',
  description: 'Government of Alberta carbon offset emission factor reference, pinned to Handbook version 3.2.',
  notes,
  isOfficial: true,
  isActive: true,
} satisfies Prisma.FactorSourceCreateWithoutVersionsInput;

export const albertaEgdfFactor = {
  activityType: 'ELECTRICITY',
  displayName: ALBERTA_EGDF_NAME,
  category: 'ELECTRICITY',
  scope: null,
  description: notes,
  isSystem: true,
  isActive: true,
} satisfies Prisma.FactorCreateWithoutVersionsInput;

export const albertaEgdfVersion = {
  factorId: ALBERTA_EGDF_FACTOR_ID,
  version: ALBERTA_EGDF_VERSION,
  sourceId: ALBERTA_EGDF_SOURCE_ID,
  factorValue: new Prisma.Decimal('0.4303'),
  inputUnit: 'MWh',
  resultUnit: 'tCO2e',
  jurisdictionCountry: 'Canada',
  jurisdictionRegion: 'Alberta',
  factorYear: 2026,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: new Date('2026-12-31T23:59:59.999Z'),
  status: 'OFFICIAL',
  confidenceLevel: 'OFFICIAL_GOVERNMENT',
  verificationStatus: 'OFFICIAL_SOURCE',
  verified: false,
  methodology: 'Grid Displacement',
  applicability: 'ALBERTA_OFFSET_PROJECT',
  emissionBasis: 'DIRECT_CO2E',
  methodologyProvenance: provenance,
  sourcePage: '5',
  sourceTable: ALBERTA_EGDF_TABLE,
  sourceSection: ALBERTA_EGDF_TABLE,
  sourceRow: 'Electricity grid displacement with renewable generation',
  sourceColumn: '2026',
  citationText: 'Government of Alberta, Carbon Offset Emission Factors Handbook, version 3.2 (August 2025), Table 1: 2026 renewable electricity grid displacement, 0.4303 tCO2e/MWh.',
  notes,
} satisfies Prisma.FactorVersionUncheckedCreateInput;

// Admin Factors still reads ConversionFactor. This is a compatibility projection
// of the same library entry, not a second independently governed factor.
export const albertaEgdfLegacy = {
  organizationId: null,
  name: ALBERTA_EGDF_NAME,
  type: 'EMISSION',
  activityType: 'ELECTRICITY',
  country: 'Canada',
  region: 'Alberta',
  jurisdiction: 'Alberta',
  unit: albertaEgdfVersion.inputUnit,
  factorValue: albertaEgdfVersion.factorValue,
  resultUnit: albertaEgdfVersion.resultUnit,
  sourceName: albertaEgdfSource.sourceAuthority,
  sourceAuthority: albertaEgdfSource.sourceAuthority,
  sourceDocument: albertaEgdfSource.sourceDocument,
  sourceReference: ALBERTA_EGDF_TABLE,
  sourceUrl: ALBERTA_EGDF_SOURCE_URL,
  sourceYear: 2025,
  effectiveFrom: albertaEgdfVersion.effectiveFrom,
  effectiveTo: albertaEgdfVersion.effectiveTo,
  methodology: albertaEgdfVersion.methodology,
  applicability: albertaEgdfVersion.applicability,
  emissionBasis: albertaEgdfVersion.emissionBasis,
  methodologyProvenance: {
    ...provenance,
    sourceVersion: '3.2',
    publishedDate: '2025-08-20',
    factorYear: 2026,
    factorVersion: ALBERTA_EGDF_VERSION,
    sourceTable: ALBERTA_EGDF_TABLE,
  },
  confidenceLevel: 'OFFICIAL_GOVERNMENT',
  verificationStatus: 'OFFICIAL_SOURCE',
  verified: false,
  // Shared-library visibility only. Applicability blocks inventory matching.
  isSystemDefault: true,
  isDefault: false,
  notes,
} satisfies Prisma.ConversionFactorUncheckedCreateInput;

/** Narrow data load: never run the demo seed, migrations, or fixture seed. */
export async function seedAlbertaEgdf2026(prisma: PrismaClient) {
  return prisma.$transaction(async tx => {
    const sameName = await tx.factor.findMany({ where: { displayName: ALBERTA_EGDF_NAME }, select: { id: true } });
    const sameLegacyName = await tx.conversionFactor.findMany({ where: { name: ALBERTA_EGDF_NAME }, select: { id: true } });
    if ([...sameName, ...sameLegacyName].some(record => record.id !== ALBERTA_EGDF_FACTOR_ID)) {
      throw new Error('A different record already uses the official factor name; review it before loading.');
    }
    // Empty updates make reruns true no-ops, preserving later governance edits.
    await tx.factorSource.upsert({ where: { id: ALBERTA_EGDF_SOURCE_ID }, update: {}, create: { id: ALBERTA_EGDF_SOURCE_ID, ...albertaEgdfSource } });
    await tx.factor.upsert({ where: { id: ALBERTA_EGDF_FACTOR_ID }, update: {}, create: { id: ALBERTA_EGDF_FACTOR_ID, ...albertaEgdfFactor } });
    const version = await tx.factorVersion.upsert({ where: { factorId_version: { factorId: ALBERTA_EGDF_FACTOR_ID, version: ALBERTA_EGDF_VERSION } }, update: {}, create: albertaEgdfVersion });
    await tx.conversionFactor.upsert({ where: { id: ALBERTA_EGDF_FACTOR_ID }, update: {}, create: { id: ALBERTA_EGDF_FACTOR_ID, ...albertaEgdfLegacy } });
    return { factorId: ALBERTA_EGDF_FACTOR_ID, factorVersionId: version.id, sourceId: ALBERTA_EGDF_SOURCE_ID };
  });
}

export function assertEgdfDevelopmentTarget(env: Record<string, string | undefined>, confirmedEndpoint: string | undefined) {
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch { throw new Error('Invalid development database configuration.'); }
  const endpoint = url.hostname.split('.')[0].replace(/-pooler$/, '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech') ||
      url.hostname !== env.NEON_DEVELOPMENT_HOST || confirmedEndpoint !== endpoint ||
      !confirmedEndpoint?.startsWith('ep-') || url.searchParams.get('sslmode') !== 'require' ||
      url.searchParams.has('host') || url.searchParams.has('hostaddr') ||
      env.NODE_ENV !== 'development' || env.APP_ENV !== 'local' ||
      /prod|production|staging|stage|main/i.test(url.hostname + url.pathname)) {
    throw new Error('Refusing data load: confirm the configured endpoint belongs to Neon development and pass --confirmed-development-endpoint=<endpoint-id>.');
  }
}
