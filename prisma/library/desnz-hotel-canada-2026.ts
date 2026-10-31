import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export const DESNZ_HOTEL_CANADA_2026_SOURCE_ID =
  'official-source-desnz-ghg-conversion-factors-2026-hotel';
export const DESNZ_HOTEL_CANADA_2026_SOURCE_URL =
  'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026';
export const DESNZ_HOTEL_CANADA_2026_VERSION = '2026.1';
export const DESNZ_HOTEL_CANADA_2026_VALUE = '7.4';

const DISPLAY_NAME = 'Hotel stay - Canada - occupied room-night - 2026';
const SOURCE_VERSION = '2026 (revised flat file, 31 July 2026)';
const REVIEWED_BY = 'CarbonLite paid-pilot methodology review';
const SOURCE_ROW = 'Hotel stay | Canada | Room per night | kg CO2e';
const METHODOLOGY =
  'Country median hotel emissions intensity per occupied room-night. Quantity must equal occupied rooms multiplied by nights; it is not a person-night factor.';

function factorId(): string {
  return `factor_${createHash('md5')
    .update(`HOTEL|${DISPLAY_NAME}|room-night`)
    .digest('hex')}`;
}

export const DESNZ_HOTEL_CANADA_2026_FACTOR_ID = factorId();

export const desnzHotelCanada2026Source = {
  sourceAuthority: 'UK Department for Energy Security and Net Zero',
  sourceShortName: 'DESNZ',
  sourceDocument: '2026 Government greenhouse gas conversion factors for company reporting',
  sourceVersion: SOURCE_VERSION,
  sourceYear: 2026,
  sourceUrl: DESNZ_HOTEL_CANADA_2026_SOURCE_URL,
  page: 'Flat file: Hotel stay; Methodology paper: section 11',
  sourcePage: 'Flat file: Hotel stay; Methodology paper: section 11',
  tableReference: SOURCE_ROW,
  sourceTable: 'Hotel stay',
  publishedDate: new Date('2026-07-31T00:00:00.000Z'),
  country: 'Canada',
  jurisdictionRegion: 'Canada',
  publisherType: 'GOVERNMENT',
  description:
    'Official company-reporting factor for Scope 3 overnight hotel business travel in Canada.',
  notes:
    'The Canada result is based on the Cornell Hotel Sustainability Benchmarking Index 2021 country median across hotel classes. DESNZ states that hotel values are unchanged since the 2022 conversion-factor release.',
  isOfficial: true,
  isActive: true,
} satisfies Prisma.FactorSourceCreateWithoutVersionsInput;

export const desnzHotelCanada2026Factor = {
  activityType: 'HOTEL',
  displayName: DISPLAY_NAME,
  category: 'HOTEL',
  scope: 'Scope 3',
  description:
    'Canada hotel-stay emissions for corporate Scope 3 business travel, measured per occupied room-night.',
  isSystem: true,
  isActive: true,
} satisfies Prisma.FactorCreateWithoutVersionsInput;

const methodologyProvenance = {
  methodologyDocument: '2026 Government greenhouse gas conversion factors methodology paper',
  methodologyVersion: SOURCE_VERSION,
  methodologyMethod: METHODOLOGY,
  methodologySection: '11 Hotel Stay',
  methodologyLevel: 'Canada country median across hotel classes',
  quantityBasis: 'OCCUPIED_ROOM_NIGHT',
  sourceVersion: SOURCE_VERSION,
  publishedDate: '2026-07-31',
  factorYear: 2026,
  factorVersion: DESNZ_HOTEL_CANADA_2026_VERSION,
  sourceTable: 'Hotel stay',
  flatFileRowId: '29_600_4007_13_1',
  sourceUnit: 'Room per night',
  occupancyTreatment:
    'Allocated per occupied room-night; guest occupancy does not change the factor. Multiple rooms require rooms multiplied by nights.',
  corporateReportingUse: 'Scope 3 business travel — hotel stays',
  benchmarkProvenance:
    'Cornell Hotel Sustainability Benchmarking Index 2021, using annual data from international hotel organizations; median country benchmark across hotel classes.',
  geographyLimitations:
    'Canada-specific country benchmark. The underlying sample is weighted toward larger, upmarket and branded hotels.',
  gwpProvenance:
    'Published as aggregate CO2e by contributing hotels; DESNZ notes reporting may use AR4 or AR5 and does not provide gas-component breakdown.',
  wellToTankIncluded: false,
  derivedFactorKgCO2ePerOccupiedRoomNight: DESNZ_HOTEL_CANADA_2026_VALUE,
};

const reviewNotes =
  'Approved only for occupied room-night activity. CarbonLite workbook unit "nights" is not automatically equivalent unless the source record explicitly represents rooms x nights; no occupancy or person-night conversion is permitted.';

export const desnzHotelCanada2026Version = {
  factorId: DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
  version: DESNZ_HOTEL_CANADA_2026_VERSION,
  factorValue: new Prisma.Decimal(DESNZ_HOTEL_CANADA_2026_VALUE),
  inputUnit: 'room-night',
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
  reviewedAt: new Date('2026-10-30T00:00:00.000Z'),
  reviewNotes,
  approvalSource: 'DESNZ 2026 GHG conversion factors, revised flat file and methodology section 11',
  sourceId: DESNZ_HOTEL_CANADA_2026_SOURCE_ID,
  sourcePage: 'Flat file: Hotel stay; Methodology paper: section 11',
  sourceSection: '11 Hotel Stay',
  sourceTable: 'Hotel stay',
  sourceRow: SOURCE_ROW,
  sourceColumn: 'kg CO2e',
  citationText: 'DESNZ, 2026 Government greenhouse gas conversion factors for company reporting, Hotel stay, Canada.',
  notes: reviewNotes,
  applicability: 'CORPORATE_INVENTORY',
  emissionBasis: 'DIRECT_CO2E',
  methodologyProvenance,
} satisfies Prisma.FactorVersionUncheckedCreateInput;

export const desnzHotelCanada2026Legacy = {
  organizationId: null,
  name: DISPLAY_NAME,
  type: 'EMISSION',
  activityType: 'HOTEL',
  country: 'Canada',
  region: 'Canada',
  jurisdiction: 'Canada',
  unit: 'room-night',
  factorValue: new Prisma.Decimal(DESNZ_HOTEL_CANADA_2026_VALUE),
  resultUnit: 'kgCO2e',
  sourceName: desnzHotelCanada2026Source.sourceAuthority,
  sourceAuthority: desnzHotelCanada2026Source.sourceAuthority,
  sourceDocument: desnzHotelCanada2026Source.sourceDocument,
  sourceReference: SOURCE_ROW,
  sourceUrl: DESNZ_HOTEL_CANADA_2026_SOURCE_URL,
  sourceYear: 2026,
  effectiveFrom: desnzHotelCanada2026Version.effectiveFrom,
  effectiveTo: desnzHotelCanada2026Version.effectiveTo,
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
export async function seedDesnzHotelCanada2026(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const [sameName, sameLegacyName] = await Promise.all([
      tx.factor.findFirst({ where: { displayName: DISPLAY_NAME }, select: { id: true } }),
      tx.conversionFactor.findFirst({ where: { name: DISPLAY_NAME }, select: { id: true } }),
    ]);
    if ((sameName && sameName.id !== DESNZ_HOTEL_CANADA_2026_FACTOR_ID) ||
        (sameLegacyName && sameLegacyName.id !== DESNZ_HOTEL_CANADA_2026_FACTOR_ID)) {
      throw new Error(`A different record already uses the production factor name: ${DISPLAY_NAME}`);
    }

    await tx.factorSource.upsert({
      where: { id: DESNZ_HOTEL_CANADA_2026_SOURCE_ID },
      update: {},
      create: { id: DESNZ_HOTEL_CANADA_2026_SOURCE_ID, ...desnzHotelCanada2026Source },
    });
    await tx.factor.upsert({
      where: { id: DESNZ_HOTEL_CANADA_2026_FACTOR_ID },
      update: {},
      create: { id: DESNZ_HOTEL_CANADA_2026_FACTOR_ID, ...desnzHotelCanada2026Factor },
    });
    const version = await tx.factorVersion.upsert({
      where: {
        factorId_version: {
          factorId: DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
          version: DESNZ_HOTEL_CANADA_2026_VERSION,
        },
      },
      update: { factorValue: desnzHotelCanada2026Version.factorValue },
      create: desnzHotelCanada2026Version,
    });
    await tx.conversionFactor.upsert({
      where: { id: DESNZ_HOTEL_CANADA_2026_FACTOR_ID },
      update: { factorValue: desnzHotelCanada2026Legacy.factorValue },
      create: { id: DESNZ_HOTEL_CANADA_2026_FACTOR_ID, ...desnzHotelCanada2026Legacy },
    });
    return {
      sourceId: DESNZ_HOTEL_CANADA_2026_SOURCE_ID,
      factorId: DESNZ_HOTEL_CANADA_2026_FACTOR_ID,
      factorVersionId: version.id,
    };
  });
}

export function assertHotelDevelopmentTarget(
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
