import { ConflictException } from '@nestjs/common';
import { LegalHoldsService } from './legal-holds.service';

const baseHold = {
  id: 'hold-1',
  organizationId: 'org-a',
  caseReference: 'case-opaque-1',
  authorityReference: 'authority-1',
  evidenceReference: null,
  status: 'ACTIVE',
  effectiveAt: new Date('2026-11-05T00:00:00.000Z'),
  documents: [] as { documentId: string }[],
};

function setup() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    legalHold: { findMany: jest.fn().mockResolvedValue([]) },
    activityData: { findFirst: jest.fn().mockResolvedValue(null) },
    report: { findFirst: jest.fn().mockResolvedValue(null) },
    metricResult: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: jest.fn((work) => work(tx)),
    legalHoldEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  return { tx, prisma, service: new LegalHoldsService(prisma as never) };
}

describe('LegalHoldsService deletion enforcement', () => {
  it('blocks an organization-wide hold with the stable confidential contract', async () => {
    const { tx, service } = setup();
    tx.legalHold.findMany.mockResolvedValue([{ ...baseHold, scopeType: 'ORGANIZATION' }]);
    const work = jest.fn();

    let caught: unknown;
    try {
      await service.withDeletionGuard({ organizationId: 'org-a', operation: 'DELETE_DOCUMENT' }, work);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      code: 'LEGAL_HOLD_ACTIVE',
      message: 'Deletion is temporarily restricted.',
    });
    expect(JSON.stringify((caught as ConflictException).getResponse())).not.toContain('case-opaque');
    expect(work).not.toHaveBeenCalled();
  });

  it('resolves a held document through activity provenance', async () => {
    const { tx, service } = setup();
    tx.legalHold.findMany.mockResolvedValue([{
      ...baseHold,
      scopeType: 'DOCUMENT',
      documents: [{ documentId: 'doc-held' }],
    }]);
    tx.activityData.findFirst.mockResolvedValue({ documentId: null, sourceDocumentId: 'doc-held' });

    await expect(service.withDeletionGuard({
      organizationId: 'org-a',
      operation: 'BULK_DELETE_ACTIVITY',
      activityIds: ['activity-held', 'activity-free'],
    }, jest.fn())).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows an unrelated target in the same organization', async () => {
    const { tx, service } = setup();
    tx.legalHold.findMany.mockResolvedValue([{
      ...baseHold,
      scopeType: 'DOCUMENT',
      documents: [{ documentId: 'doc-held' }],
    }]);
    const work = jest.fn().mockResolvedValue('deleted');

    await expect(service.withDeletionGuard({
      organizationId: 'org-a',
      operation: 'DELETE_ACTIVITY',
      activityIds: ['activity-free'],
    }, work)).resolves.toBe('deleted');
    expect(work).toHaveBeenCalledWith(tx);
  });

  it('fails closed when the hold read fails', async () => {
    const { tx, service } = setup();
    tx.legalHold.findMany.mockRejectedValue(new Error('database unavailable'));
    const work = jest.fn();

    await expect(service.withDeletionGuard({
      organizationId: 'org-a',
      operation: 'DELETE_REPORT',
      reportIds: ['report-1'],
    }, work)).rejects.toThrow('database unavailable');
    expect(work).not.toHaveBeenCalled();
  });
});
