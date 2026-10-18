import { CalculationQualityService, manualSourceProvenanceFromAudit } from './calculation-quality.service';

const original = { id: 'manual-1', sourceType: 'MANUAL', activityType: 'ELECTRICITY', recordDate: '2026-10-14T00:00:00.000Z', quantity: '980', unit: 'kWh', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', facilityId: null, facilityName: 'Main Office' };
const audit = { id: 'audit-1', entityId: 'manual-1', userId: 'actor-1', createdAt: new Date('2026-10-14T23:21:28.981Z'), newValue: original };

describe('manual report provenance', () => {
  it('projects the real creation actor/time and original activity values', () => {
    expect(manualSourceProvenanceFromAudit(audit, 'manual-1')).toEqual({ auditId: 'audit-1', actorId: 'actor-1', createdAt: audit.createdAt.toISOString(), activityDataId: 'manual-1', activityType: 'ELECTRICITY', recordDate: original.recordDate, quantity: 980, unit: 'kWh', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', facilityId: null, facilityName: 'Main Office' });
  });
  it('does not fabricate missing, mismatched or incomplete provenance', () => {
    for (const value of [undefined, { ...audit, userId: null }, { ...audit, entityId: 'other' }, { ...audit, newValue: {} }, { ...audit, newValue: { ...original, id: 'other' } }, { ...audit, newValue: { ...original, sourceType: 'DOCUMENT_AI' } }]) {
      expect(manualSourceProvenanceFromAudit(value, 'manual-1')).toBeNull();
    }
  });
  it('loads only organization-scoped creation evidence for included manual records', async () => {
    const prisma = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({}) },
      activityData: { findMany: jest.fn().mockResolvedValue([]) },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue([audit]) },
    };
    const service = new CalculationQualityService(prisma as never);
    const details = [{ activityDataId: 'manual-1', sourceType: 'MANUAL', manualSourceProvenance: null }, { activityDataId: 'imported-1', sourceType: 'DOCUMENT_AI' }];
    jest.spyOn(service, 'evaluate').mockReturnValue({ calculationDetails: details } as never);
    const result = await service.buildSummary('org-1');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-1', action: 'CREATE_ACTIVITY_RECORD', entityType: 'ActivityData', entityId: { in: ['manual-1'] } } }));
    expect(result.calculationDetails[0].manualSourceProvenance?.actorId).toBe('actor-1');
    expect(result.calculationDetails[1].manualSourceProvenance).toBeUndefined();
  });
});

// Exercise the actual manual creation boundary and its existing append-only audit.
describe('new manual activity provenance at creation', () => {
  it('retains actor, original jurisdiction/location, factor snapshot and result through the creation audit', async () => {
    const { ActivityDataService } = await import('../activity-data/activity-data.service');
    const { Prisma } = await import('@prisma/client');
    const storedAudits: Array<Record<string, any>> = [];
    const createdAt = new Date('2026-10-16T12:00:00.000Z');
    const prisma = { activityData: { create: jest.fn(async ({ data }) => ({ ...data, id: 'new-manual', createdAt })) } };
    const auditLog = { log: jest.fn(async (event) => {
      const persisted = JSON.parse(JSON.stringify(event));
      storedAudits.push({ ...persisted, id: 'new-audit', createdAt });
    }) };
    const subject = new ActivityDataService(prisma as never, auditLog as never, { track: jest.fn() } as never, { prepareCreate: jest.fn(async (_client, data) => data) } as never);
    const input = {
      sourceType: 'MANUAL', activityType: 'ELECTRICITY', recordDate: '2026-10-14', quantity: 980, unit: 'kWh',
      jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', facilityName: 'Main Office',
      matchedFactorId: 'electricity-ab', matchedFactorVersion: '2.1', matchedFactorValue: .53,
      calculatedEmissionsKgCO2e: 519.4, calculationStatus: 'CALCULATED',
    };
    const created = await subject.create('org-1', input as never, 'actor-1');
    expect(created.quantity).toEqual(new Prisma.Decimal(980));
    expect(storedAudits).toHaveLength(1);
    const persisted = storedAudits[0];
    expect(persisted).toMatchObject({ action: 'CREATE_ACTIVITY_RECORD', entityType: 'ActivityData', entityId: 'new-manual', userId: 'actor-1', newValue: { ...input, recordDate: '2026-10-14T00:00:00.000Z', quantity: '980' } });
    input.quantity = 1;
    const origin = manualSourceProvenanceFromAudit(persisted as never, 'new-manual');
    expect(origin).toMatchObject({ auditId: 'new-audit', actorId: 'actor-1', activityDataId: 'new-manual', quantity: 980, unit: 'kWh', jurisdictionCountry: 'Canada', jurisdictionRegion: 'Alberta', facilityName: 'Main Office' });
    expect(persisted.newValue).toMatchObject({ matchedFactorId: 'electricity-ab', matchedFactorVersion: '2.1', matchedFactorValue: .53, calculatedEmissionsKgCO2e: 519.4 });
    expect(persisted.newValue.sourceDocumentId).toBeNull();
    expect(persisted.newValue.sourceFileName).toBeNull();
  });
});
