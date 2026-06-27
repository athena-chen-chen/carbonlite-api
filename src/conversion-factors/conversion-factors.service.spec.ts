import { Prisma } from '@prisma/client';
import { ConversionFactorsService } from './conversion-factors.service';

describe('ConversionFactorsService Factor Library adapter', () => {
  const auditLog = { log: jest.fn() } as never;
  const activityTracking = { track: jest.fn() } as never;

  function legacyFactor(overrides: Record<string, unknown> = {}) {
    return {
      id: 'legacy-system-diesel',
      organizationId: null,
      name: 'Diesel legacy system',
      type: 'EMISSION',
      activityType: 'DIESEL',
      unit: 'liters',
      factorValue: new Prisma.Decimal(2.68),
      resultUnit: 'kgCO2e',
      sourceName: 'CarbonLite system defaults',
      sourceReference: 'Pilot demo factor library',
      sourceAuthority: 'CarbonLite system defaults',
      sourceDocument: 'Pilot demo factor library',
      sourceYear: 2025,
      sourceUrl: null,
      confidenceLevel: 'DEMO',
      verified: false,
      isDefault: true,
      isSystemDefault: true,
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function governedVersion(overrides: Record<string, unknown> = {}) {
    return {
      id: 'factor-version-diesel-2025',
      factorId: 'factor-diesel',
      version: '2025-demo',
      factorValue: new Prisma.Decimal(2.7),
      inputUnit: 'liters',
      resultUnit: 'kgCO2e',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2025,
      status: 'VERIFIED',
      confidenceLevel: 'OFFICIAL_GOVERNMENT',
      updatedAt: new Date('2025-02-01T00:00:00.000Z'),
      factor: {
        id: 'factor-diesel',
        activityType: 'DIESEL',
        displayName: 'Diesel combustion',
        isActive: true,
      },
      source: {
        sourceAuthority: 'CarbonLite system defaults',
        sourceDocument: 'Pilot demo factor library',
        sourceYear: 2025,
        sourceUrl: null,
      },
      ...overrides,
    };
  }

  function service(input: { legacy?: unknown[]; governed?: unknown[] }) {
    const prisma = {
      conversionFactor: {
        findMany: jest.fn().mockResolvedValue(input.legacy ?? []),
      },
      factorVersion: {
        findMany: jest.fn().mockResolvedValue(input.governed ?? []),
      },
    } as never;

    return new ConversionFactorsService(prisma, auditLog, activityTracking);
  }

  it('prefers organization custom conversion factors over governed system factors', async () => {
    const adapter = service({
      legacy: [
        legacyFactor(),
        legacyFactor({
          id: 'custom-diesel',
          organizationId: 'org-1',
          name: 'Org diesel custom',
          isSystemDefault: false,
          factorValue: new Prisma.Decimal(3.1),
          confidenceLevel: 'CUSTOM',
        }),
      ],
      governed: [governedVersion()],
    });

    await expect(
      adapter.getApplicableFactor({
        activityType: 'DIESEL',
        inputUnit: 'L',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        factorYear: 2025,
        organizationId: 'org-1',
      }),
    ).resolves.toMatchObject({
      factorValue: 3.1,
      inputUnit: 'liters',
      factorId: 'custom-diesel',
      confidenceLevel: 'CUSTOM',
      factorType: 'ORGANIZATION_CUSTOM',
    });
  });

  it('retrieves current applicable governed factor by jurisdiction and year', async () => {
    const adapter = service({
      legacy: [],
      governed: [
        governedVersion({
          id: 'electricity-bc-2025',
          status: 'VERIFIED',
          confidenceLevel: 'OFFICIAL_GOVERNMENT',
          factorValue: new Prisma.Decimal(0.02),
          inputUnit: 'kWh',
          jurisdictionRegion: 'British Columbia',
          factor: { activityType: 'ELECTRICITY', displayName: 'Electricity - BC', isActive: true },
        }),
        governedVersion({
          id: 'electricity-ab-2025',
          status: 'VERIFIED',
          confidenceLevel: 'OFFICIAL_GOVERNMENT',
          factorValue: new Prisma.Decimal(0.53),
          inputUnit: 'kWh',
          jurisdictionRegion: 'Alberta',
          factor: { activityType: 'ELECTRICITY', displayName: 'Electricity - Alberta', isActive: true },
        }),
      ],
    });

    await expect(
      adapter.getApplicableFactor({
        activityType: 'ELECTRICITY',
        inputUnit: 'kWh',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        factorYear: 2025,
        organizationId: 'org-1',
      }),
    ).resolves.toMatchObject({
      factorValue: 0.53,
      factorVersionId: 'electricity-ab-2025',
      factorType: 'GOVERNED_LIBRARY',
      status: 'VERIFIED',
      confidenceLevel: 'OFFICIAL_GOVERNMENT',
    });
  });

  it('does not select deprecated governed versions', async () => {
    const adapter = service({
      legacy: [],
      governed: [governedVersion({ status: 'DEPRECATED' })],
    });

    await expect(
      adapter.getApplicableFactor({
        activityType: 'DIESEL',
        inputUnit: 'liters',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        factorYear: 2025,
        organizationId: 'org-1',
      }),
    ).resolves.toBeNull();
  });

  it('does not mark demo factors as official', async () => {
    const adapter = service({
      legacy: [],
      governed: [governedVersion({ status: 'DRAFT', confidenceLevel: 'DEMO' })],
    });

    const match = await adapter.getApplicableFactor({
      activityType: 'DIESEL',
      inputUnit: 'liters',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2025,
      organizationId: 'org-1',
    });

    expect(match).toBeNull();
  });

  it('falls back to legacy system defaults while reports still use current calculation path', async () => {
    const adapter = service({ legacy: [legacyFactor()], governed: [] });

    await expect(
      adapter.getApplicableFactor({
        activityType: 'DIESEL',
        inputUnit: 'L',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        factorYear: 2025,
        organizationId: 'org-1',
      }),
    ).resolves.toMatchObject({
      factorValue: 2.68,
      factorType: 'LEGACY_SYSTEM_DEFAULT',
      status: 'DRAFT',
      confidenceLevel: 'DEMO',
    });
  });
});


describe('ConversionFactorsService factor governance lifecycle', () => {
  const auditLog = { log: jest.fn() } as never;
  const activityTracking = { track: jest.fn() } as never;

  function source(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      sourceAuthority: 'Environment and Climate Change Canada',
      sourceDocument: 'ECCC NIR 2025 Annex D',
      sourceVersion: '2025',
      sourceYear: 2025,
      sourceUrl: 'https://example.com/eccc.pdf',
      sourceShortName: 'ECCC',
      publisherType: 'GOVERNMENT',
      isOfficial: true,
      isActive: true,
      page: '12',
      tableReference: 'Annex D',
      publishedDate: new Date('2025-04-01T00:00:00.000Z'),
      notes: 'Official source fixture',
      ...overrides,
    };
  }

  function version(overrides: Record<string, unknown> = {}) {
    return {
      id: 'factor-version-1',
      factorId: 'factor-diesel',
      version: '2025-v1',
      factorValue: new Prisma.Decimal(2.68),
      inputUnit: 'liters',
      resultUnit: 'kgCO2e',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Alberta',
      factorYear: 2025,
      status: 'DRAFT',
      confidenceLevel: 'OFFICIAL_GOVERNMENT',
      verified: false,
      sourceId: 'source-1',
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
      approvalSource: null,
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      factor: {
        id: 'factor-diesel',
        activityType: 'DIESEL',
        displayName: 'Diesel combustion',
        isActive: true,
      },
      source: source(),
      ...overrides,
    };
  }

  function governanceService(currentVersion: unknown, options: { replacement?: unknown } = {}) {
    const prisma = {
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(currentVersion),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ ...(currentVersion as Record<string, unknown>), ...data }),
        ),
        findFirst: jest.fn().mockResolvedValue(options.replacement ?? null),
      },
      factorReviewLog: {
        create: jest.fn().mockResolvedValue({ id: 'review-1' }),
      },
      factorChangeLog: {
        create: jest.fn().mockResolvedValue({ id: 'change-1' }),
      },
    } as never;

    return {
      service: new ConversionFactorsService(prisma, auditLog, activityTracking),
      prisma: prisma as any,
    };
  }

  it('cannot verify without source', async () => {
    const { service } = governanceService(version({ source: null }));

    await expect(
      service.verifyFactor('factor-version-1', { reviewedBy: 'Athena Chen' }),
    ).rejects.toThrow('A source is required before verifying a factor version.');
  });

  it('cannot verify without reviewer', async () => {
    const { service } = governanceService(version());

    await expect(
      service.verifyFactor('factor-version-1', { reviewedBy: '' }),
    ).rejects.toThrow('Reviewed by is required before verifying a factor version.');
  });

  it('cannot verify without a valid review date', async () => {
    const { service } = governanceService(version());

    await expect(
      service.verifyFactor('factor-version-1', {
        reviewedBy: 'Athena Chen',
        reviewedAt: new Date('not-a-date'),
      }),
    ).rejects.toThrow('Reviewed at is required before verifying a factor version.');
  });

  it('official government confidence requires an official source', async () => {
    const { service } = governanceService(
      version({
        source: source({ sourceAuthority: 'CarbonLite system defaults' }),
      }),
    );

    await expect(
      service.verifyFactor('factor-version-1', { reviewedBy: 'Athena Chen' }),
    ).rejects.toThrow('Official government confidence requires an official source authority.');
  });

  it('cannot verify against an archived official source', async () => {
    const { service } = governanceService(
      version({
        source: source({ isActive: false }),
      }),
    );

    await expect(
      service.verifyFactor('factor-version-1', { reviewedBy: 'Athena Chen' }),
    ).rejects.toThrow('Archived sources cannot be used for new production-ready factor versions.');
  });

  it('approved factor becomes production ready', async () => {
    const reviewedAt = new Date('2026-06-26T12:00:00.000Z');
    const existing = version();
    const ready = {
      ...existing,
      verified: true,
      status: 'VERIFIED',
      reviewedBy: 'Athena Chen',
      reviewedAt,
      approvalSource: 'ECCC',
    };
    const { service, prisma } = governanceService(existing);
    prisma.factorVersion.update.mockResolvedValue(ready);
    prisma.factorVersion.findUnique
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(ready);

    await expect(
      service.approveFactor('factor-version-1', {
        reviewedBy: 'Athena Chen',
        reviewedAt,
        approvalSource: 'ECCC',
        reviewNotes: 'Confirmed against ECCC NIR 2025 Annex D.',
      }),
    ).resolves.toMatchObject({ verified: true, status: 'VERIFIED' });

    await expect(service.isProductionReady('factor-version-1')).resolves.toBe(true);
    expect(prisma.factorVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['VERIFIED', 'OFFICIAL'] } }),
      }),
    );
    expect(prisma.factorReviewLog.create).toHaveBeenCalled();
    expect(prisma.factorChangeLog.create).toHaveBeenCalled();
  });

  it('cannot archive latest active version without replacement', async () => {
    const { service } = governanceService(version({ status: 'VERIFIED', verified: true }));

    await expect(service.archiveFactor('factor-version-1')).rejects.toThrow(
      'Cannot archive the latest active factor version unless another active version replaces it.',
    );
  });



  it('creates a new draft version without changing the previous version', async () => {
    const previous = version({ id: 'factor-version-2025', version: 'v2025.1' });
    const created = {
      ...previous,
      id: 'factor-version-2026',
      version: 'v2026.1',
      factorYear: 2026,
      factorValue: new Prisma.Decimal(2.75),
      status: 'DRAFT',
      verified: false,
    };
    const prisma = {
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factor: { findUnique: jest.fn().mockResolvedValue(previous.factor) },
      factorSource: { findUnique: jest.fn().mockResolvedValue(previous.source) },
      factorVersion: {
        findFirst: jest.fn().mockResolvedValue(previous),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(created),
      },
      factorChangeLog: { create: jest.fn().mockResolvedValue({ id: 'change-1' }) },
    } as never;
    const service = new ConversionFactorsService(prisma, auditLog, activityTracking);

    await expect(
      service.createNewFactorVersion(
        'factor-diesel',
        { factorYear: 2026, factorValue: 2.75 },
        'New reporting year',
        'user-1',
      ),
    ).resolves.toMatchObject({
      id: 'factor-version-2026',
      version: 'v2026.1',
      factorValue: 2.75,
      status: 'DRAFT',
    });

    expect((prisma as any).factorVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          factorYear: 2026,
          factorValue: expect.any(Prisma.Decimal),
          status: 'DRAFT',
        }),
      }),
    );
    expect((prisma as any).factorChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'VALUE_CHANGED',
          oldFactorVersionId: 'factor-version-2025',
          newFactorVersionId: 'factor-version-2026',
        }),
      }),
    );
  });

  it('allows draft version edits', async () => {
    const existing = version({ status: 'DRAFT', verified: false });
    const updated = { ...existing, factorValue: new Prisma.Decimal(2.72) };
    const prisma = {
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorSource: { findUnique: jest.fn().mockResolvedValue(existing.source) },
      factorVersion: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue(updated),
      },
      factorChangeLog: { create: jest.fn().mockResolvedValue({ id: 'change-1' }) },
    } as never;
    const service = new ConversionFactorsService(prisma, auditLog, activityTracking);

    await expect(
      service.updateDraftFactorVersion('factor-version-1', { factorValue: 2.72 }, 'Correction', 'user-1'),
    ).resolves.toMatchObject({ factorValue: 2.72 });
  });

  it('prevents direct edits to verified versions', async () => {
    const existing = version({ status: 'VERIFIED', verified: true });
    const prisma = {
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findUnique: jest.fn().mockResolvedValue(existing) },
    } as never;
    const service = new ConversionFactorsService(prisma, auditLog, activityTracking);

    await expect(
      service.updateDraftFactorVersion('factor-version-1', { factorValue: 2.72 }, 'Correction', 'user-1'),
    ).rejects.toThrow('Verified or official factor versions are immutable. Create a new factor version instead.');
  });

  it('deprecates an older active version when a replacement is verified', async () => {
    const oldVersion = version({ id: 'old-version', status: 'VERIFIED', verified: true });
    const newVersion = version({ id: 'new-version', version: 'v2025.2', status: 'DRAFT', verified: false });
    const verifiedNewVersion = {
      ...newVersion,
      status: 'VERIFIED',
      verified: true,
      reviewedBy: 'Athena Chen',
      reviewedAt: new Date('2026-06-26T12:00:00.000Z'),
    };
    const prisma = {
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: {
        findUnique: jest.fn().mockResolvedValue(newVersion),
        findMany: jest.fn().mockResolvedValue([oldVersion]),
        update: jest
          .fn()
          .mockResolvedValueOnce({ ...oldVersion, status: 'DEPRECATED' })
          .mockResolvedValueOnce(verifiedNewVersion),
      },
      factorReviewLog: { create: jest.fn().mockResolvedValue({ id: 'review-1' }) },
      factorChangeLog: { create: jest.fn().mockResolvedValue({ id: 'change-1' }) },
    } as never;
    const service = new ConversionFactorsService(prisma, auditLog, activityTracking);

    await expect(
      service.verifyFactor('new-version', { reviewedBy: 'Athena Chen' }),
    ).resolves.toMatchObject({ id: 'new-version', status: 'VERIFIED' });

    expect((prisma as any).factorVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'old-version' }, data: { status: 'DEPRECATED' } }),
    );
    expect((prisma as any).factorChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'VERSION_DEPRECATED',
          oldFactorVersionId: 'old-version',
          newFactorVersionId: 'new-version',
        }),
      }),
    );
  });

  it('deprecated factor is not returned by default applicable-factor search', async () => {
    const adapter = new ConversionFactorsService(
      {
        conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
        factorVersion: { findMany: jest.fn().mockResolvedValue([version({ status: 'DEPRECATED' })]) },
      } as never,
      auditLog,
      activityTracking,
    );

    await expect(
      adapter.getApplicableFactor({
        activityType: 'DIESEL',
        inputUnit: 'liters',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        factorYear: 2025,
        organizationId: 'org-1',
      }),
    ).resolves.toBeNull();
  });
});
