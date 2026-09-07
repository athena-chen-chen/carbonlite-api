import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { OrganizationsService } from './organizations.service';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  organizationId: 'org-1',
  organizationName: 'CarbonLite Sample Workspace',
  role: UserRole.ADMIN,
  accountType: 'CUSTOMER',
};

const reviewerUser = {
  ...adminUser,
  id: 'reviewer-1',
  email: 'reviewer@example.com',
  role: UserRole.USER,
  accountType: 'PILOT_REVIEWER',
};

describe('OrganizationsService organization profile', () => {
  const prisma = {
    organization: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  let service: OrganizationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrganizationsService(prisma as never);
  });

  it('loads the current workspace profile without exposing other organizations', async () => {
    prisma.organization.findFirst.mockResolvedValue({
      id: 'org-1',
      name: 'CarbonLite Sample Workspace',
      industry: null,
      otherIndustry: null,
      country: null,
      provinceState: null,
      city: null,
      primaryContactName: null,
      primaryContactEmail: null,
      reportingPeriodStart: null,
      reportingPeriodEnd: null,
      geographicBoundary: null,
      includedFacilitiesOrLocations: null,
      excludedFacilitiesOrLocations: null,
      includedScopes: null,
      scope3CoverageNote: null,
      exclusionsAndLimitations: null,
      boundaryNotes: null,
    });

    await expect(service.getOrganizationProfile(adminUser)).resolves.toMatchObject({
      organizationName: 'CarbonLite Sample Workspace',
      industry: 'Technology',
      country: 'Canada',
      provinceOrState: 'Alberta',
      city: 'Calgary',
      reportingPeriodStart: '2026-01-01',
      reportingPeriodEnd: '2026-12-31',
    });
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'org-1',
        isActive: true,
      },
    });
  });

  it('returns not found when the authenticated workspace is unavailable', async () => {
    prisma.organization.findFirst.mockResolvedValue(null);

    await expect(service.getOrganizationProfile(adminUser)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows an admin to save workspace-level boundary settings', async () => {
    prisma.organization.update.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        provinceState: data.provinceState,
      }),
    );

    const result = await service.updateOrganizationProfile(adminUser, {
      organizationName: 'KACH CANADA LTD.',
      industry: 'Technology',
      country: 'Canada',
      provinceOrState: 'Alberta',
      city: 'Calgary',
      primaryContactEmail: ' Athena+Pilot@Example.ca ',
      reportingPeriodStart: '2026-01-01',
      reportingPeriodEnd: '2026-12-31',
      geographicBoundary: 'Canadian operations',
      includedFacilitiesOrLocations: 'Calgary office',
      includedScopes: 'Scope 1, Scope 2, and selected Scope 3',
      scope3CoverageNote: 'Selected Scope 3 only.',
      exclusionsAndLimitations: 'Workflow review only.',
      boundaryNotes: 'Pilot notes.',
    });

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: expect.objectContaining({
        name: 'KACH CANADA LTD.',
        industry: 'Technology',
        country: 'Canada',
        provinceState: 'Alberta',
        primaryContactEmail: 'athena+pilot@example.ca',
      }),
    });
    expect(result).toMatchObject({
      organizationName: 'KACH CANADA LTD.',
      primaryContactEmail: 'athena+pilot@example.ca',
    });
  });

  it('blocks pilot reviewer updates with a friendly read-only error', async () => {
    await expect(
      service.updateOrganizationProfile(reviewerUser, {
        organizationName: 'CarbonLite Sample Workspace',
        industry: 'Technology',
        country: 'Canada',
        provinceOrState: 'Alberta',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('rejects invalid email and reporting period order', async () => {
    const baseDto = {
      organizationName: 'KACH CANADA LTD.',
      industry: 'Technology',
      country: 'Canada',
      provinceOrState: 'Alberta',
    };

    await expect(
      service.updateOrganizationProfile(adminUser, {
        ...baseDto,
        primaryContactEmail: '[athena@example.com](mailto:athena@example.com)',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.updateOrganizationProfile(adminUser, {
        ...baseDto,
        reportingPeriodStart: '2026-12-31',
        reportingPeriodEnd: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
