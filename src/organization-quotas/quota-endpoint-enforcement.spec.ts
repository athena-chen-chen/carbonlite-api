import { Test } from '@nestjs/testing';
import { ActivityDataService } from '../activity-data/activity-data.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CalculationSnapshotsService } from '../metrics/calculation-snapshots.service';
import { DOCUMENT_STORAGE } from '../documents/document-storage';
import { DocumentsService } from '../documents/documents.service';
import { DocumentExtractionService } from '../document-extraction/document-extraction.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpreadsheetImportService } from '../spreadsheet-import/spreadsheet-import.service';

describe('quota enforcement at import service boundaries', () => {
  it.each([
    [
      'document upload',
      DocumentsService,
      [
        { provide: PrismaService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: ActivityTrackingService, useValue: {} },
        { provide: DOCUMENT_STORAGE, useValue: {} },
      ],
    ],
    [
      'bulk activity import',
      ActivityDataService,
      [
        { provide: PrismaService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: ActivityTrackingService, useValue: {} },
        { provide: CalculationSnapshotsService, useValue: {} },
      ],
    ],
    [
      'spreadsheet import',
      SpreadsheetImportService,
      [
        { provide: PrismaService, useValue: {} },
        { provide: ActivityTrackingService, useValue: {} },
      ],
    ],
    [
      'AI extraction',
      DocumentExtractionService,
      [
        { provide: PrismaService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: ActivityTrackingService, useValue: {} },
        { provide: CalculationSnapshotsService, useValue: {} },
      ],
    ],
  ])('fails application wiring for %s when quota enforcement is unavailable', async (
    _name,
    service,
    dependencies,
  ) => {
    await expect(
      Test.createTestingModule({ providers: [service, ...dependencies] }).compile(),
    ).rejects.toThrow(/OrganizationQuotasService/);
  });

  it('checks bulk activity imports before validation or persistence', async () => {
    const quotas = {
      assertImportRows: jest.fn().mockRejectedValue(new Error('row quota reached')),
    };
    const prisma = { activityData: { createMany: jest.fn() } };
    const service = new ActivityDataService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      quotas as never,
    );

    await expect(service.bulkImport('org-a', { items: [{}] } as never, 'user-a'))
      .rejects.toThrow('row quota reached');
    expect(quotas.assertImportRows).toHaveBeenCalledWith('org-a', 1);
    expect(prisma.activityData.createMany).not.toHaveBeenCalled();
  });

  it('checks spreadsheet staging before creating a source document', async () => {
    const quotas = {
      assertImportRows: jest.fn().mockRejectedValue(new Error('row quota reached')),
    };
    const prisma = { $transaction: jest.fn() };
    const service = new SpreadsheetImportService(
      prisma as never,
      {} as never,
      quotas as never,
    );

    await expect(service.saveReviewRows(
      'org-a',
      { sourceType: 'CSV', rows: [{}] } as never,
      'user-a',
    )).rejects.toThrow('row quota reached');
    expect(quotas.assertImportRows).toHaveBeenCalledWith('org-a', 1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
