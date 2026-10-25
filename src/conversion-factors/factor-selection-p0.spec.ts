import { Prisma } from '@prisma/client';
import { isFactorAllowedForWorkspace } from './factor-calculation-policy';
import { ConversionFactorsService } from './conversion-factors.service';
import { CalculationQualityService } from '../metrics/calculation-quality.service';
import { CalculationSnapshotsService } from '../metrics/calculation-snapshots.service';
import { DocumentExtractionService } from '../document-extraction/document-extraction.service';
import { ActivityDataService } from '../activity-data/activity-data.service';
import { buildJsonActivityPreview, toJsonPreviewFactorCandidates } from '../activity-data/json-activity-records';
import { matchBestFactor } from '../metrics/metrics.utils';

jest.mock('../openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));
const factor = (overrides: any = {}) => ({ id: 'official', name: 'Diesel combustion', activityType: 'DIESEL', type: 'EMISSION',
  organizationId: null, unit: 'L', factorValue: new Prisma.Decimal(2.68), resultUnit: 'kgCO2e', country: 'Canada', region: 'Alberta', jurisdiction: 'Alberta',
  sourceYear: 2026, sourceAuthority: 'Environment and Climate Change Canada', sourceDocument: 'Reviewed source', verified: true,
  isSystemDefault: true, isDefault: true, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...overrides });
const version = (overrides: any = {}) => ({ ...factor(), id: 'version', factorId: 'identity', inputUnit: 'L', factorYear: 2026,
  jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', status: 'OFFICIAL', confidenceLevel: 'OFFICIAL_GOVERNMENT',
  factor: { id: 'identity', activityType: 'DIESEL', displayName: 'Diesel', isActive: true, isSystem: true },
  source: { sourceAuthority: 'Environment and Climate Change Canada', sourceDocument: 'Reviewed source', isActive: true }, ...overrides });
const input: any = { id: 'record', organizationId: 'org', activityType: 'DIESEL', quantity: 10, unit: 'L', recordDate: new Date('2026-09-30'),
  jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', sourceType: 'MANUAL', document: null };
function setup(legacy: any[] = [], governed: any[] = [], demo = false) {
  const organization = { id: 'org', country: 'Canada', provinceState: 'Alberta', defaultReportingYear: null, allowDemoFactorsForCalculations: demo };
  const client: any = {
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue(organization) },
    conversionFactor: { findMany: jest.fn().mockResolvedValue(legacy) }, factorVersion: { findMany: jest.fn().mockResolvedValue(governed) },
    activityData: { create: jest.fn(async ({ data }) => ({ ...data, id: 'created' })), update: jest.fn(async ({ data }) => data), findMany: jest.fn().mockResolvedValue([]) },
    metricResult: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
    auditLog: { create: jest.fn() }, userActivityEvent: { create: jest.fn() },
    document: { findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'diesel.csv' }), update: jest.fn() },
    spreadsheetImportReviewRow: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([{ id: 'doc' }]),
  };
  client.$transaction = jest.fn((arg: any) => typeof arg === 'function' ? arg(client) : Promise.all(arg));
  const quality = new CalculationQualityService(client);
  const snapshots = new CalculationSnapshotsService(client, quality);
  const lookup = new ConversionFactorsService(client, { log: jest.fn() } as never, { track: jest.fn() } as never);
  const evaluate = () => quality.evaluate({ organization, records: [input], factors: legacy, governedFactors: governed, recalculate: true }).calculationDetails[0];
  return { client, organization, quality, snapshots, lookup, evaluate };
}
const lookupInput = { activityType: 'DIESEL', inputUnit: 'L', recordYear: 2026, jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', organizationId: 'org' };

describe('P0 workspace eligibility across real service boundaries (in-memory Prisma)', () => {
  it.each([
    { confidenceLevel: 'DEMO' }, { confidenceLevel: 'Low (Placeholder)' }, { status: 'SYNTHETIC_TEST' }, { status: 'TEST_ONLY' }, { isPilotEstimate: true },
    { name: 'Synthetic RC history factor' }, { sourceAuthority: 'Synthetic test only' },
    { sourceDocument: 'Manual test factor' }, { sourceAuthority: 'CarbonLite System Defaults' },
    { sourceDocument: 'CarbonLite Default Factor Library v1.0' }, { methodologyProvenance: { isTestOnly: true } },
  ])('rejects demonstrated test metadata %j in legacy canonical and lookup paths', async metadata => {
    const candidate = factor(metadata); const { evaluate, lookup, snapshots, client } = setup([candidate]);
    expect(isFactorAllowedForWorkspace(candidate, { organizationId: 'org' })).toBe(false);
    expect(evaluate()).toMatchObject({ status: 'MISSING_FACTOR', calculatedEmissionsKgCO2e: null });
    await expect(lookup.getApplicableFactor({ ...lookupInput, allowDemoFactors: true, allowPlaceholderFactors: true })).resolves.toMatchObject({ matched: false });
    await expect(snapshots.prepareCreate(client, { ...input, matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', calculatedEmissionsKgCO2e: 999 }))
      .resolves.toMatchObject({ calculationStatus: 'MISSING_FACTOR', calculatedEmissionsKgCO2e: null, matchedFactorId: null });
    expect(matchBestFactor({ activityType: 'DIESEL', unit: 'L', metricType: 'CARBON_EMISSION', organizationId: 'org', factors: [candidate] })).toBeNull();
  });

  it.each([false, true])('preserves intended demo behavior only with the persisted organization opt-in %s', async demo => {
    const legacy = factor({ confidenceLevel: 'DEMO', sourceAuthority: 'CarbonLite System Defaults' });
    const { evaluate, lookup } = setup([legacy], [], demo);
    expect(evaluate().status).toBe(demo ? 'CALCULATED' : 'MISSING_FACTOR');
    expect((await lookup.getApplicableFactor({ ...lookupInput, allowDemoFactors: true })).matched).toBe(demo);
  });

  it('allows official system and legitimate organization factors', async () => {
    for (const candidate of [factor(), factor({ organizationId: 'org', isSystemDefault: false, sourceAuthority: 'Customer laboratory', name: 'Pressure test measurement' })]) {
      const { evaluate, lookup } = setup([candidate]);
      expect(evaluate()).toMatchObject({ status: 'CALCULATED', calculatedEmissionsKgCO2e: 26.8 });
      expect((await lookup.getApplicableFactor(lookupInput)).matched).toBe(true);
    }
    expect(setup([], [version()]).evaluate().status).toBe('CALCULATED');
  });

  it.each([false, true])('rejects a foreign tenant even with a system flag and demo=%s', async demo => {
    const candidate = factor({ organizationId: 'other-org' });
    const { evaluate, lookup } = setup([candidate], [], demo);
    expect(evaluate().status).toBe('MISSING_FACTOR');
    expect((await lookup.getApplicableFactor(lookupInput)).matched).toBe(false);
    expect(matchBestFactor({ activityType: 'DIESEL', unit: 'L', metricType: 'CARBON_EMISSION', organizationId: 'org', factors: [candidate], allowDemoFactorsForCalculations: demo })).toBeNull();
  });

  it('cannot use a verified synthetic own-tenant override, but can choose a legitimate alternative', () => {
    const synthetic = factor({ id: 'synthetic', organizationId: 'org', isSystemDefault: false, sourceAuthority: 'Synthetic RC fixture' });
    expect(setup([synthetic]).evaluate().status).toBe('MISSING_FACTOR');
    expect(setup([synthetic, factor()]).evaluate()).toMatchObject({ status: 'CALCULATED', factorId: 'official' });
  });

  it.each([
    { confidenceLevel: 'DEMO', status: 'DRAFT' },
    { source: { sourceDocument: 'Synthetic fixture', isActive: true } },
    { factor: { activityType: 'ELECTRICITY', displayName: 'Manual test factor', isSystem: true, isActive: true } },
  ])('blocks governed nested markers and the old pilot-electricity exception: %j', metadata => {
    const candidate = version({ ...metadata, inputUnit: 'kWh', jurisdictionRegion: 'Alberta', factorYear: 2025,
      factor: { activityType: 'ELECTRICITY', displayName: 'Electricity', isActive: true, isSystem: true, ...metadata.factor } });
    const { quality, organization } = setup([], [candidate]);
    const result = quality.evaluate({ organization, records: [{ ...input, activityType: 'ELECTRICITY', unit: 'kWh' }], factors: [], governedFactors: [candidate], recalculate: true });
    expect(result.calculationDetails[0].status).toBe('MISSING_FACTOR');
  });

  it('JSON preview preserves governed source markers instead of dropping them during adaptation', () => {
    const candidate = version({ source: { sourceAuthority: 'Synthetic fixture' } });
    const factors = toJsonPreviewFactorCandidates({ governedFactors: [candidate] });
    const record = { facilityName: 'Office', serviceLocation: 'Calgary', province: 'Alberta', activityType: 'Diesel', quantity: 10, unit: 'L', date: '2026-09-30' };
    const normal = buildJsonActivityPreview({ organizationId: 'org', records: [record], factors });
    expect(normal.records[0]).toMatchObject({ matchedFactorStatus: 'Missing Factor' });
    expect(normal.records[0].estimatedEmissionsKgCO2e).toBeUndefined();
    expect(buildJsonActivityPreview({ organizationId: 'org', allowDemoFactorsForCalculations: true, records: [record], factors }).records[0].matchedFactorStatus).toBe('Matched');
  });

  it('direct ActivityData creation saves review state, not client-supplied demo emissions', async () => {
    const { client, snapshots } = setup([factor({ confidenceLevel: 'DEMO' })]);
    const service = new ActivityDataService(client, { log: jest.fn() } as never, { track: jest.fn() } as never, snapshots);
    const created = await service.create('org', { ...input, recordDate: '2026-09-30', calculatedEmissionsKgCO2e: 999, calculationStatus: 'CALCULATED', matchingStatus: 'MATCHED', reportTreatment: 'INCLUDED' });
    expect(created).toMatchObject({ calculationStatus: 'MISSING_FACTOR', matchedFactorId: null, calculatedEmissionsKgCO2e: null });
  });

  it('Confirm reevaluates and rejects spoofed ready/snapshot metadata on repeated imports', async () => {
    const { client, snapshots } = setup([factor({ organizationId: 'org', isSystemDefault: false, sourceAuthority: 'Synthetic RC fixture' })]);
    const service = new DocumentExtractionService(client, {} as never, { track: jest.fn() } as never, snapshots);
    const forged = { ...input, recordDate: '2026-09-30', sourceRow: 1, matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', calculatedEmissionsKgCO2e: 999, matchedFactorId: 'official' };
    for (const doc of ['doc', 'replacement']) expect((await service.confirmImport('org', doc, [forged])).count).toBe(0);
    expect(client.activityData.create).not.toHaveBeenCalled();
  });

  it('recalculation removes rejected current results while preserving prior snapshot evidence in audit', async () => {
    const { client, snapshots } = setup([factor({ confidenceLevel: 'DEMO' })]);
    const historical = { version: 1, result: { value: 26.8 }, factor: { id: 'official' } };
    const updated = await snapshots.recalculate(client, { ...input, calculationVersion: 1, calculationSnapshot: historical }, 'actor');
    expect(updated).toMatchObject({ calculationStatus: 'MISSING_FACTOR', calculatedEmissionsKgCO2e: null, matchedFactorId: null });
    expect(client.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ oldValue: historical }) }));
  });
});

it('blocks the exact known demo seed owner when its demo setting is disabled', () => {
  expect(isFactorAllowedForWorkspace({ organizationId: 'demo-org-id' }, { organizationId: 'demo-org-id' })).toBe(false);
  expect(isFactorAllowedForWorkspace({ organizationId: 'demo-org-id' }, { organizationId: 'demo-org-id', allowDemoFactorsForCalculations: true })).toBe(true);
  expect(isFactorAllowedForWorkspace({ organizationId: 'legitimate-owner' }, { organizationId: 'legitimate-owner' })).toBe(true);
});

it.each([false, true])('JSON preview service reads the persisted workspace policy (demo=%s)', async demo => {
  const { client, snapshots } = setup([factor({ confidenceLevel: 'DEMO' })], [], demo);
  const service = new ActivityDataService(client, { log: jest.fn() } as never, { track: jest.fn() } as never, snapshots);
  const result = await service.previewJsonImport('org', { data: [{ facilityName: 'Office', serviceLocation: 'Calgary', province: 'Alberta', activityType: 'Diesel', quantity: 10, unit: 'L', date: '2026-09-30' }] } as any);
  expect(result.records[0].matchedFactorStatus).toBe(demo ? 'Matched' : 'Missing Factor');
  expect(client.organization.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'org' } });
  expect(client.activityData.create).not.toHaveBeenCalled();
});
