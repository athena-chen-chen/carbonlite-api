import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { ActivityDataController } from './activity-data.controller';
import { AdminActivityRecordsController } from './admin-activity-records.controller';
import { ActivityDataService } from './activity-data.service';
import { CreateActivityDataDto } from './dto/create-activity-data.dto';
import { ResetDemoDataDto } from './dto/reset-demo-data.dto';
import { UpdateActivityDataDto } from './dto/update-activity-data.dto';
import { AuthenticatedUser } from '../auth/auth.service';

const authenticatedUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'member@example.com',
  organizationId: 'org-1',
  organizationName: 'Org 1',
  role: 'USER',
};

const canonicalPayload = {
  activityType: 'ELECTRICITY',
  recordDate: '2026-07-20',
  quantity: 12500,
  unit: 'kWh',
  jurisdictionCountry: 'Canada',
  jurisdictionRegion: 'Alberta',
  recordYear: 2026,
  sourceType: 'MANUAL',
  sourceReference: 'manual',
  dateEstimated: false,
  matchingStatus: 'MATCHED',
  reportTreatment: 'INCLUDED',
  scope: 'SCOPE_2',
  matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
  matchedFactorName: 'Electricity - Alberta',
  matchedFactorSourceYear: 2025,
  matchedFactorValue: 0.53,
  matchedFactorUnit: 'kgCO2e/kWh',
  matchedFactorVersion: 'v1.0',
  matchedFactorSourceAuthority: 'CarbonLite',
  matchedFactorSourceDocument: 'CarbonLite MVP Default Factors v1.0',
  matchedFactorVerificationStatus: 'INTERNAL_REVIEW_REQUIRED',
  matchedFactorConfidenceLevel: 'LOW',
  matchedFactorAssumptions: 'Pilot default electricity factor.',
  calculatedEmissionsKgCO2e: 6625,
  calculationStatus: 'CALCULATED',
  calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
};

const createMetadata: ArgumentMetadata = {
  type: 'body',
  metatype: CreateActivityDataDto,
};

const updateMetadata: ArgumentMetadata = {
  type: 'body',
  metatype: UpdateActivityDataDto,
};

const resetDemoDataMetadata: ArgumentMetadata = {
  type: 'body',
  metatype: ResetDemoDataDto,
};

describe('ActivityDataController canonical calculation fields', () => {
  const validationPipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const activityDataService = {
    create: jest.fn(),
    update: jest.fn(),
  };
  const controller = new ActivityDataController(
    activityDataService as unknown as ActivityDataService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts canonical calculation fields for POST payload validation and response', async () => {
    const dto = await validationPipe.transform(canonicalPayload, createMetadata);
    activityDataService.create.mockResolvedValue({
      id: 'activity-1',
      organizationId: 'org-1',
      ...dto,
    });

    const response = await controller.create(authenticatedUser, dto);

    expect(activityDataService.create).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        matchingStatus: 'MATCHED',
        matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
        matchedFactorValue: 0.53,
        matchedFactorVersion: 'v1.0',
        calculatedEmissionsKgCO2e: 6625,
      }),
      'user-1',
    );
    expect(response).toMatchObject({
      matchingStatus: 'MATCHED',
      reportTreatment: 'INCLUDED',
      scope: 'SCOPE_2',
      matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
      matchedFactorName: 'Electricity - Alberta',
      matchedFactorSourceYear: 2025,
      matchedFactorValue: 0.53,
      matchedFactorUnit: 'kgCO2e/kWh',
      matchedFactorVersion: 'v1.0',
      matchedFactorSourceAuthority: 'CarbonLite',
      matchedFactorSourceDocument: 'CarbonLite MVP Default Factors v1.0',
      matchedFactorVerificationStatus: 'INTERNAL_REVIEW_REQUIRED',
      matchedFactorConfidenceLevel: 'LOW',
      matchedFactorAssumptions: 'Pilot default electricity factor.',
      calculatedEmissionsKgCO2e: 6625,
      calculationStatus: 'CALCULATED',
      calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
    });
  });

  it('accepts canonical calculation fields for PATCH payload validation and response', async () => {
    const patchPayload = {
      matchingStatus: 'MATCHED',
      reportTreatment: 'INCLUDED',
      scope: 'SCOPE_2',
      matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
      matchedFactorName: 'Electricity - Alberta 2025',
      matchedFactorSourceYear: 2025,
      matchedFactorValue: 0.53,
      matchedFactorUnit: 'kgCO2e/kWh',
      matchedFactorVersion: 'v1.0',
      matchedFactorSourceAuthority: 'CarbonLite',
      matchedFactorSourceDocument: 'CarbonLite MVP Default Factors v1.0',
      matchedFactorVerificationStatus: 'INTERNAL_REVIEW_REQUIRED',
      matchedFactorConfidenceLevel: 'LOW',
      matchedFactorAssumptions: 'Pilot default electricity factor.',
      calculatedEmissionsKgCO2e: 6625,
      calculationStatus: 'CALCULATED',
      calculationMessage: 'Matched factor. Using latest available factor year: 2025.',
    };
    const dto = await validationPipe.transform(patchPayload, updateMetadata);
    activityDataService.update.mockResolvedValue({
      id: 'activity-1',
      organizationId: 'org-1',
      ...dto,
    });

    const response = await controller.update(authenticatedUser, 'activity-1', dto);

    expect(activityDataService.update).toHaveBeenCalledWith(
      'org-1',
      'activity-1',
      expect.objectContaining({
        matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
        matchedFactorValue: 0.53,
        matchedFactorVersion: 'v1.0',
        calculatedEmissionsKgCO2e: 6625,
      }),
      'user-1',
    );
    expect(response).toMatchObject({
      matchedFactorId: 'cmr75gv6l0007gdjbs0bz4d3j',
      matchedFactorName: 'Electricity - Alberta 2025',
      matchedFactorValue: 0.53,
      matchedFactorVersion: 'v1.0',
      calculatedEmissionsKgCO2e: 6625,
    });
  });

  it('accepts existing activity records without canonical calculation fields', async () => {
    const legacyPayload = {
      activityType: 'DIESEL',
      recordDate: '2026-07-20',
      quantity: 10,
      unit: 'L',
      sourceType: 'MANUAL',
    };
    const dto = await validationPipe.transform(legacyPayload, createMetadata);
    activityDataService.create.mockResolvedValue({
      id: 'activity-legacy',
      organizationId: 'org-1',
      ...dto,
    });

    await controller.create(authenticatedUser, dto);

    expect(activityDataService.create).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining(legacyPayload),
      'user-1',
    );
  });

  it('still rejects fields that are not defined on the DTO', async () => {
    await expect(
      validationPipe.transform(
        {
          ...canonicalPayload,
          requestBodyShouldNotPass: true,
        },
        createMetadata,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.arrayContaining([
          'property requestBodyShouldNotPass should not exist',
        ]),
      }),
    });
  });
});

describe('AdminActivityRecordsController demo data reset', () => {
  const validationPipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const activityDataService = {
    resetDemoDataForOrganization: jest.fn(),
  };
  const controller = new AdminActivityRecordsController(
    activityDataService as unknown as ActivityDataService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts RESET DEMO DATA confirmation and resets data for the current organization', async () => {
    const dto = await validationPipe.transform(
      { confirmation: 'RESET DEMO DATA' },
      resetDemoDataMetadata,
    );
    const summary = {
      activityRecordsDeleted: 2,
      importBatchesDeleted: 1,
      uploadedDocumentsDeleted: 1,
      stagedRowsDeleted: 3,
      metricsCacheCleared: 2,
    };
    activityDataService.resetDemoDataForOrganization.mockResolvedValue(summary);

    await expect(
      controller.resetDemoData(authenticatedUser, dto),
    ).resolves.toEqual(summary);

    expect(activityDataService.resetDemoDataForOrganization).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'RESET DEMO DATA',
    );
  });

  it('rejects incorrect reset confirmation text', async () => {
    await expect(
      validationPipe.transform(
        { confirmation: 'CLEAR RECORDS' },
        resetDemoDataMetadata,
      ),
    ).rejects.toThrow();

    expect(activityDataService.resetDemoDataForOrganization).not.toHaveBeenCalled();
  });
});
