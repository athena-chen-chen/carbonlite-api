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
    $transaction: jest.fn(),
    auditLog: { create: jest.fn() }, userActivityEvent: { create: jest.fn() },
    organization: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  let service: OrganizationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(callback => callback(prisma));
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', name: 'CarbonLite Sample Workspace', customerStatus: 'DEMO', allowDemoFactorsForCalculations: true, boundaryVersion: 1 });
    service = new OrganizationsService(prisma as never);
  });

  it('loads the current workspace profile without exposing other organizations', async () => {
    prisma.organization.findFirst.mockResolvedValue({
      id: 'org-1',
      name: 'CarbonLite Sample Workspace',
      customerStatus: 'DEMO', allowDemoFactorsForCalculations: true,
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

  it.each(['2026-02-30', '2025-02-29', '2026-04-31', '1900-02-29', '2026-13-01', '2026-01-00'])('rejects impossible boundary date %s before any database write', async (date) => {
    for (const key of ['reportingPeriodStart', 'reportingPeriodEnd']) {
      await expect(service.updateOrganizationProfile(adminUser, {
        organizationName: 'Synthetic', industry: 'Technology', country: 'Canada', provinceOrState: 'Alberta',
        reportingPeriodStart: '2026-01-01', reportingPeriodEnd: '2027-01-01', [key]: date,
      })).rejects.toThrow('Please enter valid reporting period dates.');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it.each(['2024-02-29', '2026-02-28', '0900-01-01', '2000-02-29', '0099-01-01'])('preserves valid boundary calendar date %s', async (date) => {
    prisma.organization.update.mockImplementation(({ data }) => Promise.resolve({ ...data }));
    const result = await service.updateOrganizationProfile(adminUser, {
      organizationName: 'Synthetic', industry: 'Technology', country: 'Canada', provinceOrState: 'Alberta',
      reportingPeriodStart: date, reportingPeriodEnd: '2027-01-01',
    });
    expect(result.reportingPeriodStart).toBe(date);
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
  const boundaryKeys = ['reportingPeriodStart', 'reportingPeriodEnd', 'geographicBoundary',
    'includedFacilitiesOrLocations', 'excludedFacilitiesOrLocations', 'includedScopes',
    'scope3CoverageNote', 'exclusionsAndLimitations', 'boundaryNotes'];

  it.each([null, ''])('returns empty customer boundaries for stored %s without writes', async value => {
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', name: 'Synthetic Workshop',
      ...Object.fromEntries(boundaryKeys.map(key => [key, value])), boundaryVersion: 1, boundaryStatus: 'DRAFT' });
    const result = await service.getOrganizationProfile(adminUser);
    for (const key of boundaryKeys) expect(result[key as keyof typeof result]).toBe('');
    expect(result).toMatchObject({ country: 'Canada', boundaryVersion: 1, boundaryStatus: 'DRAFT', boundaryReviewedAt: '' });
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({ where: { id: adminUser.organizationId, isActive: true } });
    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('preserves all persisted customer boundaries, including text matching the sample', async () => {
    const fields = Object.fromEntries(boundaryKeys.map(key => [key, `Configured ${key}`]));
    fields.geographicBoundary = 'Sample Canadian operations, including Alberta, British Columbia, and Ontario activity records';
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', name: 'Synthetic Workshop', ...fields });
    expect(await service.getOrganizationProfile(adminUser)).toMatchObject(fields);
  });

  it('saves and reloads empty customer boundaries without injecting sample text or recording a review', async () => {
    let stored = { id: 'org-1', name: 'Synthetic Workshop', industry: 'Manufacturing', country: 'Canada', provinceState: 'Alberta',
      boundaryVersion: 1, boundaryStatus: 'DRAFT' } as Record<string, any>;
    prisma.organization.findFirst.mockImplementation(async () => stored);
    prisma.organization.update.mockImplementation(async ({ where, data }) => {
      expect(where).toEqual({ id: 'org-1' }); stored = { ...stored, ...data }; return stored;
    });
    const before = await service.getOrganizationProfile(adminUser);
    const saved = await service.updateOrganizationProfile(adminUser, { ...before, organizationName: 'Renamed Synthetic Workshop' });
    expect(saved).toMatchObject({ boundaryVersion: 2, boundaryStatus: 'DRAFT', boundaryReviewedAt: '' });
    for (const key of boundaryKeys) expect((await service.getOrganizationProfile(adminUser))[key as keyof typeof saved]).toBe('');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: 'org-1', action: 'BOUNDARY_UPDATED',
      newValue: expect.objectContaining({ geographicBoundary: '', includedScopes: '', boundaryVersion: 2 }) }) });
    expect(prisma.userActivityEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventName: 'BOUNDARY_UPDATED' }) });
    await service.updateOrganizationProfile(adminUser, await service.getOrganizationProfile(adminUser));
    expect(stored.boundaryVersion).toBe(2);
  });

  it('invalidates a prior boundary review on material edits and propagates required audit failure', async () => {
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', name: 'Synthetic Workshop', industry: 'Manufacturing', country: 'Canada', provinceState: 'Alberta',
      boundaryVersion: 3, boundaryStatus: 'REVIEWED', boundaryReviewedBy: 'synthetic-reviewer', boundaryReviewedAt: new Date() });
    prisma.organization.update.mockImplementation(async ({ data }) => data);
    prisma.auditLog.create.mockRejectedValueOnce(new Error('synthetic audit failure'));
    await expect(service.updateOrganizationProfile(adminUser, { organizationName: 'Updated Synthetic Workshop', industry: 'Manufacturing', country: 'Canada', provinceOrState: 'Alberta' })).rejects.toThrow('synthetic audit failure');
    expect(prisma.organization.update).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: expect.objectContaining({ boundaryStatus: 'DRAFT', boundaryVersion: 4, boundaryReviewedAt: null }) });
  });

  it.each(['CarbonLite Sample Workspace', 'Renamed customer'])('does not trust customer name %s', async name => {
    prisma.organization.findFirst.mockResolvedValue({id:'org-1',name,customerStatus:'ACTIVE',allowDemoFactorsForCalculations:true});
    const profile=await service.getOrganizationProfile(adminUser);
    for(const key of boundaryKeys) expect(profile[key as keyof typeof profile]).toBe('');
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });
  it('preserves proven demo defaults after rename and rejects incomplete designation', async () => {
    prisma.organization.findFirst.mockResolvedValue({id:'org-1',name:'Renamed demo',customerStatus:'DEMO',allowDemoFactorsForCalculations:true});
    expect((await service.getOrganizationProfile(adminUser)).reportingPeriodStart).toBe('2026-01-01');
    prisma.organization.findFirst.mockResolvedValue({id:'org-1',name:'CarbonLite Sample Workspace',customerStatus:'DEMO',allowDemoFactorsForCalculations:false});
    expect((await service.getOrganizationProfile(adminUser)).reportingPeriodStart).toBe('');
  });

});
