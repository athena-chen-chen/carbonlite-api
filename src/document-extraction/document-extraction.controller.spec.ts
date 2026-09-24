import { DocumentExtractionController } from './document-extraction.controller';
import { DocumentExtractionService } from './document-extraction.service';
import { AuthenticatedUser } from '../auth/auth.service';

const baseUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  organizationId: 'org-1',
  organizationName: 'Org 1',
  role: 'USER',
  accountType: 'CUSTOMER',
};

describe('DocumentExtractionController permissions', () => {
  const service = {
    extract: jest.fn(),
    confirmImport: jest.fn(),
  };
  const controller = new DocumentExtractionController(
    service as unknown as DocumentExtractionService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows customer users to extract documents and confirm imported rows', async () => {
    service.extract.mockResolvedValue({
      documentId: 'doc-1',
      parsedActivities: [],
      extractedRowCount: 0,
    });
    service.confirmImport.mockResolvedValue({
      count: 1,
      createdIds: ['activity-1'],
    });

    await expect(
      controller.extract(baseUser, { documentId: 'doc-1' }),
    ).resolves.toMatchObject({ documentId: 'doc-1' });
    await expect(
      controller.confirm(baseUser, {
        documentId: 'doc-1',
        activities: [
          {
            activityType: 'Electricity',
            recordDate: '2026-01-01',
            quantity: 10,
            unit: 'kWh',
            sourceReference: 'bill.pdf',
            notes: '',
          },
        ],
      }),
    ).resolves.toMatchObject({ count: 1 });

    expect(service.extract).toHaveBeenCalledWith(
      'org-1',
      'doc-1',
      'user-1',
      'user@example.com',
    );
    expect(service.confirmImport).toHaveBeenCalledWith(
      'org-1',
      'doc-1',
      expect.any(Array),
      'user-1',
      undefined,
    );
  });

  it('blocks pilot reviewers and viewer-style users from extracting and importing rows', async () => {
    expect(() =>
      controller.extract(
        { ...baseUser, accountType: 'PILOT_REVIEWER' },
        { documentId: 'doc-1' },
      ),
    ).toThrow('Pilot reviewer accounts are read-only for sample data.');

    expect(() =>
      controller.confirm(
        { ...baseUser, membershipRole: 'VIEWER' },
        {
          documentId: 'doc-1',
          activities: [
            {
              activityType: 'Electricity',
              recordDate: '2026-01-01',
              quantity: 10,
              unit: 'kWh',
              sourceReference: 'bill.pdf',
              notes: '',
            },
          ],
        },
      ),
    ).toThrow('Your current role does not allow importing activity data.');

    expect(service.extract).not.toHaveBeenCalled();
    expect(service.confirmImport).not.toHaveBeenCalled();
  });
});
