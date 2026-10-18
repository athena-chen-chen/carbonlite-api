import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ALBERTA_EGDF_FACTOR_ID, ALBERTA_EGDF_NAME, ALBERTA_EGDF_VERSION,
  albertaEgdfFactor, albertaEgdfLegacy, albertaEgdfSource, albertaEgdfVersion,
  assertEgdfDevelopmentTarget, seedAlbertaEgdf2026,
} from './alberta-egdf-2026';
import { isInventoryFactorEligible } from '../../src/conversion-factors/factor-governance';
import { CalculationQualityService } from '../../src/metrics/calculation-quality.service';

const host = 'ep-confirmed-development-pooler.c-2.us-east-1.aws.neon.tech';
const safe = { DATABASE_URL: `postgresql://example:example@${host}/neondb?sslmode=require`, NEON_DEVELOPMENT_HOST: host, NODE_ENV: 'development', APP_ENV: 'local' };

describe('official Alberta EGDF development load', () => {
  it('requires explicit confirmation for the configured endpoint', () => {
    expect(() => assertEgdfDevelopmentTarget(safe, 'ep-confirmed-development')).not.toThrow();
    for (const endpoint of [undefined, '', 'ep-main', 'ep-another-development']) {
      expect(() => assertEgdfDevelopmentTarget(safe, endpoint)).toThrow('Refusing data load');
    }
  });

  it.each([
    { NODE_ENV: 'production' }, { APP_ENV: 'pilot' }, { NEON_DEVELOPMENT_HOST: 'different.neon.tech' },
    { DATABASE_URL: 'postgresql://example:example@localhost/carbonlite_dev' },
    { DATABASE_URL: `postgresql://example:example@${host}/main?sslmode=require` },
    { DATABASE_URL: `postgresql://example:example@${host}/neondb?sslmode=require&host=another.neon.tech` },
    { DATABASE_URL: `postgresql://example:example@${host}/neondb` },
  ])('refuses unsafe target %j', overrides => {
    expect(() => assertEgdfDevelopmentTarget({ ...safe, ...overrides }, 'ep-confirmed-development')).toThrow();
  });

  it('preserves source units, publication year and vintage separately', () => {
    expect(albertaEgdfVersion.factorValue.toString()).toBe('0.4303');
    expect(albertaEgdfVersion).toMatchObject({ inputUnit: 'MWh', resultUnit: 'tCO2e', factorYear: 2026, status: 'OFFICIAL', verified: false });
    expect(albertaEgdfSource).toMatchObject({ sourceVersion: '3.2', sourceYear: 2025, publishedDate: new Date('2025-08-20T00:00:00Z'), isOfficial: true });
    expect(albertaEgdfLegacy).toMatchObject({ sourceYear: 2025, isDefault: false, methodologyProvenance: { factorYear: 2026, factorVersion: '2026.1', publishedDate: '2025-08-20' } });
    expect(ALBERTA_EGDF_FACTOR_ID).not.toContain('dev-task7');
    expect(ALBERTA_EGDF_FACTOR_ID).toBe(`factor_${createHash('md5').update(`ELECTRICITY|${ALBERTA_EGDF_NAME}|MWh`).digest('hex')}`);
    expect(isInventoryFactorEligible(albertaEgdfVersion)).toBe(false);
    expect(isInventoryFactorEligible(albertaEgdfLegacy)).toBe(false);
  });

  it('reruns without duplicates or overwriting later governance edits', async () => {
    const tables = Object.fromEntries(['factorSource', 'factor', 'factorVersion', 'conversionFactor'].map(name => [name, new Map<string, Record<string, unknown>>() ]));
    const tx = Object.fromEntries(Object.entries(tables).map(([name, store]) => [name, {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(async ({ where, create, update }) => {
        const key = where.id ?? `${where.factorId_version.factorId}:${where.factorId_version.version}`;
        const row = store.has(key) ? { ...store.get(key), ...update } : { id: `generated-${name}`, ...create };
        store.set(key, row);
        return row;
      }),
    }]));
    const prisma = { $transaction: jest.fn(async callback => callback(tx)) } as unknown as PrismaClient;
    await seedAlbertaEgdf2026(prisma);
    const version = tables.factorVersion.get(`${ALBERTA_EGDF_FACTOR_ID}:${ALBERTA_EGDF_VERSION}`)!;
    version.reviewNotes = 'Subsequent reviewer note';
    await seedAlbertaEgdf2026(prisma);
    expect(Object.values(tables).map(table => table.size)).toEqual([1, 1, 1, 1]);
    expect(tables.factorVersion.get(`${ALBERTA_EGDF_FACTOR_ID}:${ALBERTA_EGDF_VERSION}`)?.reviewNotes).toBe('Subsequent reviewer note');
  });

  it('refuses name collisions before writing anything', async () => {
    const tx = { factor: { findMany: jest.fn().mockResolvedValue([{ id: 'dev-task7-other-id' }]), upsert: jest.fn() }, conversionFactor: { findMany: jest.fn().mockResolvedValue([]) } };
    const prisma = { $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx) } as unknown as PrismaClient;
    await expect(seedAlbertaEgdf2026(prisma)).rejects.toThrow('different record');
    expect(tx.factor.upsert).not.toHaveBeenCalled();
  });

  it('keeps 1000 kWh of ordinary Alberta inventory at 530 kgCO2e with the exact official record present', () => {
    const inventory = {
      id: 'existing-alberta', organizationId: null, name: 'Electricity - Alberta',
      activityType: 'ELECTRICITY', type: 'EMISSION', unit: 'kWh', resultUnit: 'kgCO2e',
      factorValue: new Prisma.Decimal('0.53'), sourceYear: 2025, country: 'Canada', region: 'Alberta',
      isSystemDefault: true, isDefault: false, updatedAt: new Date('2025-01-01'),
    };
    const service = new CalculationQualityService(null as never);
    const result = service.evaluate({
      organization: { id: 'org', provinceState: 'Alberta', country: 'Canada', defaultReportingYear: null, allowDemoFactorsForCalculations: true },
      records: [{ id: 'electricity-2026', organizationId: 'org', activityType: 'ELECTRICITY', quantity: new Prisma.Decimal(1000), unit: 'kWh', recordDate: new Date('2026-06-30'), jurisdictionRegion: 'Alberta', jurisdictionCountry: 'Canada', sourceType: 'MANUAL', document: null } as never],
      factors: [{ id: ALBERTA_EGDF_FACTOR_ID, ...albertaEgdfLegacy }, inventory] as never,
      governedFactors: [
        { id: 'generated-version', ...albertaEgdfVersion, factor: { id: ALBERTA_EGDF_FACTOR_ID, ...albertaEgdfFactor }, source: albertaEgdfSource },
        { id: 'existing-inventory-version', factorId: 'demo-factor-electricity-alberta', version: 'demo-2025-kwh-alberta', factorValue: new Prisma.Decimal('0.53'), inputUnit: 'kWh', resultUnit: 'kgCO2e', factorYear: 2025, jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', status: 'DRAFT', confidenceLevel: 'DEMO', updatedAt: new Date('2025-01-01'), source: { isActive: true }, factor: { id: 'demo-factor-electricity-alberta', displayName: 'Electricity - Alberta', activityType: 'ELECTRICITY', isSystem: true, isActive: true } },
      ] as never,
    });
    expect(result.totalEstimatedEmissionsKgCO2e).toBe(530);
    expect(result.calculationDetails[0]).toMatchObject({ factorValue: 0.53, factorName: 'Electricity - Alberta', calculatedEmissionsKgCO2e: 530 });
    expect(result.calculationDetails[0].factorName).not.toBe(ALBERTA_EGDF_NAME);
  });
});
