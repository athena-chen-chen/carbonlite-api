import { CalculationQualityService } from '../metrics/calculation-quality.service';
import { CalculationSnapshotsService } from '../metrics/calculation-snapshots.service';
import { DocumentExtractionService } from './document-extraction.service';
jest.mock('../openai/openai.client', () => ({ openai: { responses: { create: jest.fn() } } }));

const ready = { matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED', calculatedEmissionsKgCO2e: 26.8 };
const tracked = { matchingStatus: 'TRACKED_ONLY', calculationStatus: 'TRACKED_ONLY', reportTreatment: 'TRACKED_ONLY', scope: 'TRACKED_METRIC', calculatedEmissionsKgCO2e: null };
const input = { activityType: 'DIESEL', recordDate: '2026-03-07', quantity: 10, unit: 'liters', sourceRow: 2, sourceReference: 'source' };

function setup(results: Array<Record<string, unknown>>) {
  let nextId = 0;
  const create = jest.fn(async ({ data }) => ({ ...data, id: 'created-' + ++nextId }));
  const update = jest.fn();
  const track = jest.fn();
  const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'doc' }]), spreadsheetImportReviewRow: { findMany: jest.fn().mockResolvedValue([]) },
    activityData: { findMany: jest.fn().mockResolvedValue([]), create }, document: { update, findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'source.csv' }) } };
  const prisma = { document: { findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'source.csv' }) },
    $transaction: jest.fn(async callback => callback(tx)) };
  const prepareCreate = jest.fn(async (_client, data) => ({ ...data, ...results.shift() }));
  const service = new DocumentExtractionService(prisma as never, {} as never, { track } as never, { prepareCreate } as never);
  return { service, create, update, prepareCreate, track, tx };
}

describe('document confirmation uses server-prepared eligibility', () => {
  it.each(['MISSING_FACTOR', 'INVALID_UNIT', 'UNIT_MISMATCH', 'MISSING_JURISDICTION', 'NEEDS_REVIEW', 'REQUIRES_REVIEW', 'EXCLUDED'])('blocks canonical %s despite spoofed client statuses', async calculationStatus => {
    const { service, create, update } = setup([{ matchingStatus: calculationStatus, calculationStatus, reportTreatment: 'REQUIRES_REVIEW', calculatedEmissionsKgCO2e: null }]);
    const result = await service.confirmImport('org', 'doc', [{ ...input, ...ready, calculatedEmissionsKgCO2e: 999999, matchedFactorId: 'forged' }]);
    expect(result.count).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REVIEW_REQUIRED', importedAt: null }) }));
  });

  it.each([
    { ...ready, matchingStatus: 'MISSING_FACTOR' },
    { ...ready, reportTreatment: 'EXCLUDED' },
    { ...tracked, calculationStatus: 'INVALID_UNIT', reportTreatment: 'REQUIRES_REVIEW' },
  ])('requires the complete canonical condition rather than one ready/tracked signal', async prepared => {
    const { service, create } = setup([prepared]);
    expect((await service.confirmImport('org', 'doc', [input])).count).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('imports only two canonical emissions rows and one tracked row from a mixed nine-row request', async () => {
    const blocked = { calculationStatus: 'MISSING_FACTOR', matchingStatus: 'MISSING_FACTOR', reportTreatment: 'REQUIRES_REVIEW' };
    const { service, create, track, update } = setup([ready, ready, tracked, ...Array.from({ length: 6 }, () => blocked)]);
    const rows = Array.from({ length: 9 }, (_, index) => ({ ...input, ...ready, sourceRow: index + 2, calculatedEmissionsKgCO2e: 999999 }));
    const result = await service.confirmImport('org', 'doc', rows);
    expect(result.count).toBe(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.map(([arg]) => arg.data.calculatedEmissionsKgCO2e)).toEqual([26.8, 26.8, null]);
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ createdRecordCount: 3, trackedMetricCount: 1, unresolvedRowCount: 6, skippedCount: 6 }) }), expect.anything());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REVIEW_REQUIRED' }) }));
  });

  it('counts valid server-calculated rows as emissions even if the client claims tracked-only', async () => {
    const { service, track } = setup([ready]);
    expect((await service.confirmImport('org', 'doc', [{ ...input, ...tracked }])).count).toBe(1);
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ trackedMetricCount: 0 }) }), expect.anything());
  });
});

// Exercise the real preparation/evaluation chain with a valid fuel unit and no
// available factors; a mocked status alone cannot prove client fields are stripped.
it.each([false, true])('blocks a valid diesel row with no factors (spoofed=%s)', async spoofed => {
  const create = jest.fn();
  const update = jest.fn();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'doc' }]),
    organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org', country: 'Canada', provinceState: 'Alberta', allowDemoFactorsForCalculations: false }) },
    conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
    factorVersion: { findMany: jest.fn().mockResolvedValue([]) },
    spreadsheetImportReviewRow: { findMany: jest.fn().mockResolvedValue([]) },
    activityData: { findMany: jest.fn().mockResolvedValue([]), create },
    document: { update, findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'diesel.csv' }) },
  };
  const prisma = {
    document: { findFirst: jest.fn().mockResolvedValue({ id: 'doc', fileName: 'diesel.csv' }) },
    $transaction: jest.fn(async callback => callback(tx)),
  };
  const snapshots = new CalculationSnapshotsService(prisma as never, new CalculationQualityService(prisma as never));
  const prepare = jest.spyOn(snapshots, 'prepareCreate');
  const track = jest.fn();
  const service = new DocumentExtractionService(prisma as never, {} as never, { track } as never, snapshots);
  const forged = { ...ready, scope: 'TRACKED_METRIC', matchedFactorId: 'forged', calculatedEmissionsKgCO2e: 999999 };
  expect(await service.confirmImport('org', 'doc', [{ ...input, ...(spoofed ? forged : {}) }]))
    .toMatchObject({ count: 0, createdIds: [] });
  expect(await prepare.mock.results[0].value).toMatchObject({
    matchingStatus: 'MISSING_FACTOR', calculationStatus: 'MISSING_FACTOR',
    reportTreatment: 'REQUIRES_REVIEW', scope: 'SCOPE_1',
    matchedFactorId: null, calculatedEmissionsKgCO2e: null,
  });
  expect(create).not.toHaveBeenCalled();
  expect(track).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REVIEW_REQUIRED', importedAt: null }) }));
});

it('does not read import state until the tenant-owned document lock is acquired', async () => {
  const { service, tx } = setup([]);
  let release!: (value: Array<{ id: string }>) => void;
  tx.$queryRaw.mockImplementation(() => new Promise(done => { release = done; }));
  const pending = service.confirmImport('org', 'doc', []);
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  const [sql, ...parameters] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...string[]];
  expect(sql.join('?')).toMatch(/WHERE "id" = \? AND "organizationId" = \?[\s\S]*FOR UPDATE/);
  expect(parameters).toEqual(['doc', 'org']);
  expect(tx.document.findFirst).not.toHaveBeenCalled();
  expect(tx.spreadsheetImportReviewRow.findMany).not.toHaveBeenCalled();
  expect(tx.activityData.findMany).not.toHaveBeenCalled();
  release([{ id: 'doc' }]);
  expect((await pending).count).toBe(0);
  expect(tx.activityData.findMany).toHaveBeenCalledTimes(1);
});

it('returns not found without reading or mutating import state if the owned lock target is absent', async () => {
  const { service, tx, create, update, track } = setup([]);
  tx.$queryRaw.mockResolvedValue([]);
  await expect(service.confirmImport('other-org', 'doc', [])).rejects.toThrow('Document not found');
  expect(tx.document.findFirst).not.toHaveBeenCalled();
  expect(tx.spreadsheetImportReviewRow.findMany).not.toHaveBeenCalled();
  expect(tx.activityData.findMany).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(track).not.toHaveBeenCalled();
});
