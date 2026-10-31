import { Prisma, type PrismaClient } from '@prisma/client';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import { ALBERTA_EGDF_FACTOR_ID } from './alberta-egdf-2026';
import { seedDesnzHotelCanada2026 } from './desnz-hotel-canada-2026';
import { seedEcccElectricityCanada2026 } from './eccc-electricity-canada-2026';
import { seedEcccNaturalGasAlberta2026 } from './eccc-natural-gas-alberta-2026';
import { seedEcccRefinedPetroleum2026 } from './eccc-refined-petroleum-2026';
import { seedEpaAirTravel2025 } from './epa-air-travel-2025';
import {
  EXPECTED_PRODUCTION_FACTOR_COUNT,
  PRODUCTION_FACTOR_MANIFEST,
  type ProductionFactorManifestEntry,
} from './production-factor-manifest';

type Environment = Record<string, string | undefined>;

export type DatabaseTargetSummary = {
  environment: string;
  hostClassification: 'LOCAL' | 'NEON' | 'REMOTE';
  database: string;
  productionEnvironment: boolean;
  expectedFactors: number;
};

export type ProductionFactorVerification = {
  expected: number;
  present: number;
  eligible: number;
  missing: string[];
  invalid: string[];
  duplicates: string[];
  legacyViolations: string[];
  pass: boolean;
};

export function databaseTargetSummary(env: Environment): DatabaseTargetSummary {
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  const productionEnvironment = env.APP_ENV === 'production' || env.NODE_ENV === 'production';
  const hostname = url.hostname.toLowerCase();
  return {
    environment: env.APP_ENV ?? env.NODE_ENV ?? 'unspecified',
    hostClassification: ['localhost', '127.0.0.1', '::1'].includes(hostname)
      ? 'LOCAL' : hostname.endsWith('.neon.tech') ? 'NEON' : 'REMOTE',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(default)',
    productionEnvironment,
    expectedFactors: EXPECTED_PRODUCTION_FACTOR_COUNT,
  };
}

export function assertProductionFactorLoadAllowed(env: Environment): DatabaseTargetSummary {
  const summary = databaseTargetSummary(env);
  const url = new URL(env.DATABASE_URL!);
  const targetLooksProduction = /(?:^|[-_./])prod(?:uction)?(?:$|[-_./])/i.test(`${url.hostname}/${url.pathname}`);
  if (targetLooksProduction && !summary.productionEnvironment) {
    throw new Error('Refusing factor load: production-like database target requires APP_ENV=production or NODE_ENV=production.');
  }
  if (env.ALLOW_PRODUCTION_FACTOR_LOAD !== 'true') {
    throw new Error('Refusing factor load: set ALLOW_PRODUCTION_FACTOR_LOAD=true for this one intentional run.');
  }
  return summary;
}

export async function loadProductionFactors(prisma: PrismaClient, env: Environment) {
  const target = assertProductionFactorLoadAllowed(env);
  await seedEcccRefinedPetroleum2026(prisma);
  await seedEcccNaturalGasAlberta2026(prisma);
  await seedDesnzHotelCanada2026(prisma);
  await seedEpaAirTravel2025(prisma);
  await seedEcccElectricityCanada2026(prisma);
  const verification = await verifyProductionFactors(prisma);
  if (!verification.pass) throw new Error(`Production factor load completed but verification failed:\n${formatProductionFactorVerification(verification)}`);
  return { target, verification };
}

type GovernedCandidate = Awaited<ReturnType<typeof readCandidates>>['versions'][number];
type LegacyCandidate = Awaited<ReturnType<typeof readCandidates>>['legacy'][number];

function metadata(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function selectionKey(candidate: GovernedCandidate | LegacyCandidate): string {
  const governed = 'factor' in candidate;
  const provenance = metadata(candidate.methodologyProvenance);
  return [
    governed ? candidate.factor.activityType : candidate.activityType,
    governed ? candidate.factorYear : candidate.sourceYear,
    governed ? candidate.inputUnit : candidate.unit,
    governed ? candidate.jurisdictionCountry : candidate.country,
    governed ? candidate.jurisdictionRegion : candidate.region,
    provenance.haulCategory ?? '',
  ].map((value) => String(value ?? '')).join('|');
}

function candidateIdentity(candidate: GovernedCandidate | LegacyCandidate): string {
  return 'factor' in candidate ? candidate.factorId : candidate.id;
}

function exact(value: Prisma.Decimal | number | string, expected: unknown): boolean {
  return new Prisma.Decimal(value).equals(new Prisma.Decimal(String(expected)));
}

async function readCandidates(prisma: PrismaClient) {
  const activityTypes = [...new Set(PRODUCTION_FACTOR_MANIFEST.map((entry) => entry.factor.activityType))];
  const [versions, legacy] = await Promise.all([
    prisma.factorVersion.findMany({
      where: { factor: { activityType: { in: activityTypes } } },
      include: { factor: true, source: true },
    }),
    prisma.conversionFactor.findMany({ where: { activityType: { in: activityTypes } } }),
  ]);
  return { versions, legacy };
}

function validateExpected(entry: ProductionFactorManifestEntry, candidate: GovernedCandidate): string[] {
  const expected = entry.version;
  const source = entry.source;
  const mismatches: string[] = [];
  const compare = (label: string, actual: unknown, wanted: unknown) => {
    if (String(actual ?? '') !== String(wanted ?? '')) mismatches.push(`${entry.factorId}: ${label} mismatch`);
  };
  compare('version', candidate.version, expected.version);
  if (!exact(candidate.factorValue, expected.factorValue)) mismatches.push(`${entry.factorId}: factor value mismatch`);
  compare('activity type', candidate.factor.activityType, entry.factor.activityType);
  compare('input unit', candidate.inputUnit, expected.inputUnit);
  compare('result unit', candidate.resultUnit, expected.resultUnit);
  compare('country', candidate.jurisdictionCountry, expected.jurisdictionCountry);
  compare('region', candidate.jurisdictionRegion, expected.jurisdictionRegion);
  compare('factor year', candidate.factorYear, expected.factorYear);
  compare('source identity', candidate.sourceId, entry.sourceId);
  compare('source authority', candidate.source.sourceAuthority, source.sourceAuthority);
  compare('source document', candidate.source.sourceDocument, source.sourceDocument);
  compare('source version', candidate.source.sourceVersion, source.sourceVersion);
  compare('source year', candidate.source.sourceYear, source.sourceYear);
  compare('methodology', candidate.methodology, expected.methodology);
  compare('applicability', candidate.applicability, expected.applicability);
  compare('emission basis', candidate.emissionBasis, expected.emissionBasis);
  if (!isInventoryFactorEligible(candidate)) mismatches.push(`${entry.factorId}: governance-ineligible`);
  return mismatches;
}

export async function verifyProductionFactors(prisma: PrismaClient): Promise<ProductionFactorVerification> {
  const { versions, legacy } = await readCandidates(prisma);
  const missing: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  let eligible = 0;

  for (const entry of PRODUCTION_FACTOR_MANIFEST) {
    const candidate = versions.find((item) => item.factorId === entry.factorId && item.version === entry.version.version);
    if (!candidate) {
      missing.push(`${entry.factorId}@${entry.version.version}`);
      continue;
    }
    const mismatches = validateExpected(entry, candidate);
    invalid.push(...mismatches);
    if (!mismatches.some((reason) => reason.endsWith('governance-ineligible'))) eligible += 1;

    const competingIds = new Set(
      [...versions, ...legacy]
        .filter((item) => selectionKey(item) === entry.selectionKey && isInventoryFactorEligible(item))
        .map(candidateIdentity),
    );
    if (competingIds.size !== 1 || !competingIds.has(entry.factorId)) {
      duplicates.push(`${entry.selectionKey}: eligible identities [${[...competingIds].sort().join(', ')}]`);
    }
  }

  const expectedIds = new Set(PRODUCTION_FACTOR_MANIFEST.map((entry) => entry.factorId));
  const allCandidates: Array<GovernedCandidate | LegacyCandidate> = [...versions, ...legacy];
  const legacyViolations = new Set<string>();
  for (const candidate of allCandidates) {
    if (!isInventoryFactorEligible(candidate)) continue;
    const id = candidateIdentity(candidate);
    const governed = 'factor' in candidate;
    const activityType = governed ? candidate.factor.activityType : candidate.activityType;
    const unit = governed ? candidate.inputUnit : candidate.unit;
    const region = governed ? candidate.jurisdictionRegion : candidate.region;
    const value = candidate.factorValue;
    if (activityType === 'ELECTRICITY' && /^(?:Alberta|AB)$/i.test(region ?? '') && exact(value, '0.53')) {
      legacyViolations.add(`${id}: legacy Alberta 0.53 is eligible`);
    }
    if (id === ALBERTA_EGDF_FACTOR_ID) legacyViolations.add(`${id}: Alberta EGDF is eligible for inventory use`);
    if (!expectedIds.has(id) && activityType === 'NATURAL_GAS') {
      legacyViolations.add(`${id}: old/generic Natural Gas factor is eligible`);
    }
    if (!expectedIds.has(id) && activityType === 'HOTEL' && unit !== 'room-night') {
      legacyViolations.add(`${id}: old/generic Hotel factor is eligible`);
    }
    if (!expectedIds.has(id) && activityType === 'AIR_TRAVEL' && unit !== 'passenger-km') {
      legacyViolations.add(`${id}: old/generic Air Travel factor is eligible`);
    }
  }

  const present = EXPECTED_PRODUCTION_FACTOR_COUNT - missing.length;
  const result = {
    expected: EXPECTED_PRODUCTION_FACTOR_COUNT,
    present,
    eligible,
    missing,
    invalid,
    duplicates: [...new Set(duplicates)],
    legacyViolations: [...legacyViolations],
    pass: false,
  };
  result.pass = present === result.expected && eligible === result.expected &&
    invalid.length === 0 && result.duplicates.length === 0 && result.legacyViolations.length === 0;
  return result;
}

export function formatProductionFactorVerification(result: ProductionFactorVerification): string {
  const lines = [
    `Expected: ${result.expected}`,
    `Present: ${result.present}`,
    `Eligible: ${result.eligible}`,
    `Missing: ${result.missing.length}`,
    `Invalid: ${result.invalid.length}`,
    `Duplicates: ${result.duplicates.length}`,
    `Legacy violations: ${result.legacyViolations.length}`,
  ];
  for (const [label, reasons] of [
    ['MISSING', result.missing], ['INVALID', result.invalid],
    ['DUPLICATE', result.duplicates], ['LEGACY', result.legacyViolations],
  ] as const) for (const reason of reasons) lines.push(`${label}: ${reason}`);
  lines.push('', `PRODUCTION FACTOR GATE: ${result.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}
