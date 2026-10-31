import { Prisma, PrismaClient } from '@prisma/client';
import { seedAlbertaEgdf2026, ALBERTA_EGDF_FACTOR_ID, ALBERTA_EGDF_SOURCE_ID } from '../prisma/library/alberta-egdf-2026';
import {
  assertProductionFactorLoadAllowed,
  loadProductionFactors,
  verifyProductionFactors,
} from '../prisma/library/production-factor-deployment';
import {
  EXPECTED_PRODUCTION_FACTOR_COUNT,
  PRODUCTION_FACTOR_MANIFEST,
} from '../prisma/library/production-factor-manifest';
import {
  ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
  ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID,
  ECCC_NATURAL_GAS_ALBERTA_2026_M3_VALUE,
  ECCC_NATURAL_GAS_ALBERTA_2026_VALUE,
} from '../prisma/library/eccc-natural-gas-alberta-2026';

const prisma = new PrismaClient();
const manifestIds = PRODUCTION_FACTOR_MANIFEST.map((entry) => entry.factorId);
const sourceIds = [...new Set(PRODUCTION_FACTOR_MANIFEST.map((entry) => entry.sourceId))];
const syntheticIds = [
  'test-duplicate-production-factor',
  'test-legacy-alberta-053',
  'test-legacy-natural-gas',
  'test-reference-only-natural-gas',
];
const loadEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: 'test',
  APP_ENV: 'test',
  ALLOW_PRODUCTION_FACTOR_LOAD: 'true',
};

async function cleanDeploymentFactors() {
  await prisma.conversionFactor.deleteMany({ where: { id: { in: [...manifestIds, ...syntheticIds, ALBERTA_EGDF_FACTOR_ID] } } });
  await prisma.factorVersion.updateMany({
    where: { factorId: { in: [...manifestIds, ...syntheticIds, ALBERTA_EGDF_FACTOR_ID] } },
    data: { status: 'DRAFT' },
  });
  await prisma.factor.deleteMany({ where: { id: { in: [...manifestIds, ...syntheticIds, ALBERTA_EGDF_FACTOR_ID] } } });
  await prisma.factorSource.deleteMany({ where: { id: { in: [...sourceIds, ALBERTA_EGDF_SOURCE_ID] } } });
}

async function deploymentTableSnapshot() {
  return Promise.all([
    prisma.factor.findMany({ orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } }),
    prisma.factorVersion.findMany({ orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } }),
    prisma.factorSource.findMany({ orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } }),
    prisma.conversionFactor.findMany({ orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } }),
  ]);
}

describe('production factor deployment gate (disposable PostgreSQL)', () => {
  beforeAll(cleanDeploymentFactors);
  afterAll(async () => {
    await cleanDeploymentFactors();
    await prisma.$disconnect();
  });

  it('has one canonical manifest of 21 unique reviewed factors', () => {
    expect(EXPECTED_PRODUCTION_FACTOR_COUNT).toBe(21);
    expect(PRODUCTION_FACTOR_MANIFEST).toHaveLength(21);
    expect(new Set(manifestIds).size).toBe(21);
    expect(PRODUCTION_FACTOR_MANIFEST).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factorId: ECCC_NATURAL_GAS_ALBERTA_2026_FACTOR_ID,
        version: expect.objectContaining({ inputUnit: 'GJ', factorValue: new Prisma.Decimal(ECCC_NATURAL_GAS_ALBERTA_2026_VALUE) }),
      }),
      expect.objectContaining({
        factorId: ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID,
        version: expect.objectContaining({ inputUnit: 'm3', factorValue: new Prisma.Decimal(ECCC_NATURAL_GAS_ALBERTA_2026_M3_VALUE) }),
      }),
    ]));
  });

  it('fails empty, loads once, verifies, and remains idempotent', async () => {
    const empty = await verifyProductionFactors(prisma);
    expect(empty).toMatchObject({ pass: false, present: 0, eligible: 0 });
    expect(empty.missing).toHaveLength(21);

    await loadProductionFactors(prisma, loadEnv);
    const first = await verifyProductionFactors(prisma);
    expect(first).toMatchObject({ pass: true, present: 21, eligible: 21 });

    await loadProductionFactors(prisma, loadEnv);
    const second = await verifyProductionFactors(prisma);
    expect(second).toMatchObject({ pass: true, present: 21, eligible: 21 });
    expect(await prisma.factor.count({ where: { id: { in: manifestIds } } })).toBe(21);
    expect(await prisma.factorVersion.count({ where: { factorId: { in: manifestIds } } })).toBe(21);
  });

  it('detects missing, wrong-value, and governance-ineligible expected factors', async () => {
    const expected = PRODUCTION_FACTOR_MANIFEST.find((entry) => entry.factor.activityType === 'ELECTRICITY')!;
    await prisma.factorVersion.updateMany({ where: { factorId: expected.factorId }, data: { status: 'DRAFT' } });
    await prisma.factorVersion.delete({
      where: { factorId_version: { factorId: expected.factorId, version: String(expected.version.version) } },
    });
    expect((await verifyProductionFactors(prisma)).missing).toContain(`${expected.factorId}@${expected.version.version}`);
    await loadProductionFactors(prisma, loadEnv);

    await prisma.factorVersion.updateMany({ where: { factorId: expected.factorId }, data: { factorValue: new Prisma.Decimal('999') } });
    expect((await verifyProductionFactors(prisma)).invalid).toContain(`${expected.factorId}: factor value mismatch`);
    await loadProductionFactors(prisma, loadEnv);

    await prisma.factorVersion.updateMany({ where: { factorId: expected.factorId }, data: { verified: false } });
    expect((await verifyProductionFactors(prisma)).invalid).toContain(`${expected.factorId}: governance-ineligible`);
    await prisma.factorVersion.updateMany({ where: { factorId: expected.factorId }, data: { verified: true } });
  });

  it('requires both distinct Natural Gas activity-unit identities and the exact m3 value', async () => {
    const naturalGasEntries = PRODUCTION_FACTOR_MANIFEST.filter((entry) => entry.factor.activityType === 'NATURAL_GAS');
    expect(naturalGasEntries).toHaveLength(2);
    expect(new Set(naturalGasEntries.map((entry) => entry.selectionKey)).size).toBe(2);

    await prisma.factorVersion.updateMany({
      where: { factorId: ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID },
      data: { status: 'DRAFT' },
    });
    await prisma.factorVersion.delete({
      where: { factorId_version: { factorId: ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID, version: '2026.1' } },
    });
    const missingM3 = await verifyProductionFactors(prisma);
    expect(missingM3.pass).toBe(false);
    expect(missingM3.missing).toContain(`${ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID}@2026.1`);
    await loadProductionFactors(prisma, loadEnv);
    expect((await verifyProductionFactors(prisma)).pass).toBe(true);

    await prisma.factorVersion.updateMany({
      where: { factorId: ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID },
      data: { factorValue: new Prisma.Decimal('1.9') },
    });
    const wrongM3 = await verifyProductionFactors(prisma);
    expect(wrongM3.pass).toBe(false);
    expect(wrongM3.invalid).toContain(`${ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID}: factor value mismatch`);
    await loadProductionFactors(prisma, loadEnv);
    expect(await verifyProductionFactors(prisma)).toMatchObject({
      pass: true, present: 21, eligible: 21, missing: [], duplicates: [], legacyViolations: [],
    });
  });

  it('detects a competing eligible identity and an eligible Alberta 0.53 violation', async () => {
    const expected = PRODUCTION_FACTOR_MANIFEST.find((entry) =>
      entry.factor.activityType === 'ELECTRICITY' && entry.version.jurisdictionRegion === 'Alberta')!;
    await prisma.conversionFactor.create({
      data: { id: syntheticIds[0], ...expected.legacy, name: `${expected.legacy.name} duplicate` },
    });
    expect((await verifyProductionFactors(prisma)).duplicates.some((reason) => reason.includes(syntheticIds[0]))).toBe(true);
    await prisma.conversionFactor.delete({ where: { id: syntheticIds[0] } });

    await prisma.conversionFactor.create({
      data: {
        id: syntheticIds[1], ...expected.legacy, name: 'Legacy Alberta electricity 0.53',
        factorValue: new Prisma.Decimal('0.53'),
      },
    });
    expect((await verifyProductionFactors(prisma)).legacyViolations).toContain(`${syntheticIds[1]}: legacy Alberta 0.53 is eligible`);
    await prisma.conversionFactor.delete({ where: { id: syntheticIds[1] } });
  });

  it('blocks legacy Natural Gas while ignoring reference-only Natural Gas', async () => {
    const expected = PRODUCTION_FACTOR_MANIFEST.find((entry) =>
      entry.factorId === ECCC_NATURAL_GAS_ALBERTA_2026_M3_FACTOR_ID)!;
    await prisma.conversionFactor.create({
      data: {
        id: syntheticIds[2], ...expected.legacy, name: 'Legacy Natural Gas 1.89',
        factorValue: new Prisma.Decimal('1.89'), sourceYear: 2025,
      },
    });
    expect((await verifyProductionFactors(prisma)).legacyViolations)
      .toContain(`${syntheticIds[2]}: old/generic Natural Gas factor is eligible`);
    await prisma.conversionFactor.delete({ where: { id: syntheticIds[2] } });

    await prisma.conversionFactor.create({
      data: {
        id: syntheticIds[3], ...expected.legacy, name: 'Natural Gas reference only',
        factorValue: new Prisma.Decimal('1.89'), sourceYear: 2025,
        verified: false, verificationStatus: 'INTERNAL_REVIEW_REQUIRED', applicability: 'REFERENCE_ONLY',
      },
    });
    expect((await verifyProductionFactors(prisma)).pass).toBe(true);
    await prisma.conversionFactor.delete({ where: { id: syntheticIds[3] } });
  });

  it('keeps EGDF blocked and proves verification is read-only', async () => {
    await seedAlbertaEgdf2026(prisma);
    const before = await deploymentTableSnapshot();
    const result = await verifyProductionFactors(prisma);
    const after = await deploymentTableSnapshot();
    expect(result.pass).toBe(true);
    expect(result.legacyViolations).toEqual([]);
    expect(after).toEqual(before);
  });

  it('requires explicit opt-in before loader writes and a recognized production environment', async () => {
    expect(() => assertProductionFactorLoadAllowed({
      DATABASE_URL: 'postgresql://user:secret@db.example/prod', APP_ENV: 'production',
    })).toThrow('ALLOW_PRODUCTION_FACTOR_LOAD=true');
    expect(() => assertProductionFactorLoadAllowed({
      DATABASE_URL: 'postgresql://user:secret@prod-db.example/carbonlite', APP_ENV: 'test',
      ALLOW_PRODUCTION_FACTOR_LOAD: 'true',
    })).toThrow('production-like database target');
    expect(() => assertProductionFactorLoadAllowed({
      DATABASE_URL: process.env.DATABASE_URL, APP_ENV: 'production', ALLOW_PRODUCTION_FACTOR_LOAD: 'true',
    })).not.toThrow();
    const noWritePrisma = { $transaction: jest.fn() } as unknown as PrismaClient;
    await expect(loadProductionFactors(noWritePrisma, {
      DATABASE_URL: process.env.DATABASE_URL, APP_ENV: 'production',
    })).rejects.toThrow('ALLOW_PRODUCTION_FACTOR_LOAD=true');
    expect(noWritePrisma.$transaction).not.toHaveBeenCalled();
  });
});
