import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AuthenticatedUser } from '../auth/auth.service';

const baseUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  organizationId: 'org-1',
  organizationName: 'Org 1',
  role: 'USER',
  accountType: 'CUSTOMER',
};

const uploadFile = {
  originalname: 'bill.pdf',
  filename: 'bill.pdf',
  mimetype: 'application/pdf',
  size: 1234,
  path: '/tmp/bill.pdf',
} as Express.Multer.File;

describe('DocumentsController permissions', () => {
  const documentsService = {
    upload: jest.fn(),
  };
  const controller = new DocumentsController(
    documentsService as unknown as DocumentsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows customer users to upload files in their workspace', async () => {
    documentsService.upload.mockResolvedValue({
      id: 'doc-1',
      organizationId: 'org-1',
      fileName: 'bill.pdf',
    });

    await expect(
      controller.upload(baseUser, uploadFile, 'UTILITY_BILL'),
    ).resolves.toMatchObject({
      id: 'doc-1',
      organizationId: 'org-1',
    });

    expect(documentsService.upload).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      uploadFile,
      'UTILITY_BILL',
      false,
    );
  });

  it('blocks pilot reviewers and viewer-style users from uploading files', async () => {
    await expect(
      controller.upload(
        { ...baseUser, accountType: 'PILOT_REVIEWER' },
        uploadFile,
        'UTILITY_BILL',
      ),
    ).rejects.toThrow('Pilot reviewer accounts are read-only for sample data.');

    await expect(
      controller.upload(
        { ...baseUser, membershipRole: 'VIEWER' },
        uploadFile,
        'UTILITY_BILL',
      ),
    ).rejects.toThrow('Your current role does not allow file upload.');

    expect(documentsService.upload).not.toHaveBeenCalled();
  });
});

