import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const systemFactorMetadata = {
  default: {
    jurisdiction: 'Canada (Generic)',
    sourceAuthority: 'CarbonLite System Defaults',
    sourceDocument: 'CarbonLite MVP Default Factors v1.0',
    sourceYear: 2025,
    sourceUrl: 'https://carbonlite.ai/methodology/default-factors',
    confidenceLevel: 'Medium (Engineering Estimate)',
    verificationStatus: 'Internal Review Required',
    verified: false,
    methodology:
      'Used for pilot validation. Intended for demonstration workflows only. Replace with official ECCC or provincial emission factors before production reporting.',
    notes: 'Default system factor included with CarbonLite MVP. Not intended for regulatory reporting.',
  },
  electricity: {
    jurisdiction: 'Province Required',
    sourceAuthority: 'CarbonLite System Defaults',
    sourceDocument: 'CarbonLite MVP Default Factors v1.0',
    sourceYear: 2025,
    sourceUrl: 'https://carbonlite.ai/methodology/default-factors',
    confidenceLevel: 'Low',
    verificationStatus: 'Internal Review Required',
    verified: false,
    methodology:
      'Pilot-stage default electricity factor. Uses jurisdiction-specific electricity factor and latest available prior-year factor where no reporting-year factor exists. Replace with reviewed official factor before formal reporting.',
    notes:
      'Pilot-stage default electricity factor. Uses jurisdiction-specific electricity factor and latest available prior-year factor where no reporting-year factor exists. Replace with reviewed official factor before formal reporting.',
  },
  scope3: {
    jurisdiction: 'Canada (Generic)',
    sourceAuthority: 'CarbonLite System Defaults',
    sourceDocument: 'CarbonLite MVP Default Factors v1.0',
    sourceYear: 2025,
    sourceUrl: 'https://carbonlite.ai/methodology/default-factors',
    confidenceLevel: 'Low',
    verificationStatus: 'Internal Review Required',
    verified: false,
    methodology:
      'Pilot-stage Scope 3 estimate. Scope 3 calculations can vary by methodology, boundary, and factor source. Consultant review recommended before official reporting.',
    notes:
      'Pilot-stage Scope 3 estimate. Scope 3 calculations can vary by methodology, boundary, and factor source. Consultant review recommended before official reporting.',
  },
  water: {
    jurisdiction: 'Canada (Generic)',
    sourceAuthority: 'CarbonLite Pilot Methodology',
    sourceDocument: 'Water Emissions Placeholder Factor',
    sourceYear: 2025,
    sourceUrl: 'https://carbonlite.ai/methodology/water-emissions',
    confidenceLevel: 'Pilot Estimate',
    verificationStatus: 'Internal Review Required',
    verified: false,
    methodology:
      'Estimated indirect emissions associated with municipal water treatment and distribution. Used for pilot workflow validation only.',
    notes: 'Tracked metric with optional estimated emissions. Not intended for regulatory reporting.',
  },
  groundTransport: {
    jurisdiction: 'Canada - National',
    sourceAuthority: 'CarbonLite',
    sourceDocument: 'CarbonLite Pilot Ground Transport Estimate 2025',
    sourceYear: 2025,
    sourceUrl: 'https://carbonlite.ai/methodology/ground-transport-emissions',
    confidenceLevel: 'Pilot Estimate',
    verificationStatus: 'Internal Review Required',
    verified: false,
    methodology:
      'Estimated Scope 3 emissions for ground transport distance including taxi, rideshare, rental car, mileage, and local business travel. Used for pilot workflow validation only.',
    notes:
      'Pilot estimate for Scope 3 ground transport. Replace with a reviewed factor before formal reporting.',
  },
} as const;

function getSystemFactorMetadata(activityType: string) {
  if (activityType === 'ELECTRICITY') return systemFactorMetadata.electricity;
  if (activityType === 'WATER') return systemFactorMetadata.water;
  if (activityType === 'GROUND_TRANSPORT') return systemFactorMetadata.groundTransport;
  if (['AIR_TRAVEL', 'HOTEL', 'SHIPPING'].includes(activityType)) return systemFactorMetadata.scope3;
  return systemFactorMetadata.default;
}

async function main() {
  console.log('🌱 Seeding database...');

  const adminUpgrade = await prisma.user.updateMany({
    where: {
      email: {
        equals: 'carbonliteai@gmail.com',
        mode: 'insensitive',
      },
    },
    data: {
      role: 'ADMIN',
    },
  });

  console.log(`✅ Admin role ready: ${adminUpgrade.count} account(s) updated`);

  const org = await prisma.organization.upsert({
    where: { slug: 'demo-org' },
    update: {},
    create: {
      id: 'demo-org-id',
      name: 'Demo Organization',
      slug: 'demo-org',
      isActive: true,
    },
  });

  console.log('✅ Organization ready:', org.id);

  await prisma.factorSource.upsert({
    where: { id: 'official-source-eccc-2025-emission-factors-reference-values' },
    update: {
      sourceAuthority: 'Environment and Climate Change Canada',
      sourceShortName: 'ECCC',
      sourceDocument: 'Emission Factors and Reference Values',
      sourceVersion: '2025',
      sourceYear: 2025,
      sourceUrl: 'https://publications.gc.ca/collections/collection_2025/eccc/En84-294-2025-eng.pdf',
      page: '',
      tableReference: '',
      publishedDate: new Date('2025-01-01T00:00:00.000Z'),
      country: 'Canada',
      jurisdictionRegion: 'Canada',
      publisherType: 'GOVERNMENT',
      description:
        'Official source registry entry for ECCC 2025 emission factors and reference values. Factor values must still be reviewed before being marked verified.',
      notes:
        'Seeded source only. CarbonLite does not mark existing demo factor values as official unless manually verified against the publication.',
      isOfficial: true,
      isActive: true,
    },
    create: {
      id: 'official-source-eccc-2025-emission-factors-reference-values',
      sourceAuthority: 'Environment and Climate Change Canada',
      sourceShortName: 'ECCC',
      sourceDocument: 'Emission Factors and Reference Values',
      sourceVersion: '2025',
      sourceYear: 2025,
      sourceUrl: 'https://publications.gc.ca/collections/collection_2025/eccc/En84-294-2025-eng.pdf',
      page: '',
      tableReference: '',
      publishedDate: new Date('2025-01-01T00:00:00.000Z'),
      country: 'Canada',
      jurisdictionRegion: 'Canada',
      publisherType: 'GOVERNMENT',
      description:
        'Official source registry entry for ECCC 2025 emission factors and reference values. Factor values must still be reviewed before being marked verified.',
      notes:
        'Seeded source only. CarbonLite does not mark existing demo factor values as official unless manually verified against the publication.',
      isOfficial: true,
      isActive: true,
    },
  });

  console.log('✅ Official source registry ready: ECCC 2025');

  const defaultFactors = [
    { name: 'Diesel combustion', activityType: 'DIESEL', unit: 'liters', factorValue: 2.68, category: 'FUEL', scope: 'Scope 1' },
    { name: 'Gasoline combustion', activityType: 'GASOLINE', unit: 'liters', factorValue: 2.31, category: 'FUEL', scope: 'Scope 1' },
    { name: 'Natural gas combustion', activityType: 'NATURAL_GAS', unit: 'm3', factorValue: 1.89, category: 'NATURAL_GAS', scope: 'Scope 1' },
    {
      name: 'Electricity - Alberta',
      activityType: 'ELECTRICITY',
      unit: 'kWh',
      factorValue: 0.53,
      jurisdiction: 'Alberta',
      sourceYear: 2025,
      category: 'ELECTRICITY',
      scope: 'Scope 2',
      notes:
        'Electricity factors vary by province and reporting year. Replace with a verified jurisdiction-specific factor before client or regulatory reporting.',
    },
    {
      name: 'Electricity - British Columbia',
      activityType: 'ELECTRICITY',
      unit: 'kWh',
      factorValue: 0.02,
      jurisdiction: 'British Columbia',
      sourceYear: 2025,
      category: 'ELECTRICITY',
      scope: 'Scope 2',
      notes:
        'Demo electricity factor for workflow testing. Replace with verified jurisdiction-specific factors before client or regulatory reporting.',
    },
    {
      name: 'Electricity - Ontario',
      activityType: 'ELECTRICITY',
      unit: 'kWh',
      factorValue: 0.12,
      jurisdiction: 'Ontario',
      sourceYear: 2025,
      category: 'ELECTRICITY',
      scope: 'Scope 2',
      notes:
        'Demo electricity factor for workflow testing. Replace with verified jurisdiction-specific factors before client or regulatory reporting.',
    },
    { name: 'Air travel', activityType: 'AIR_TRAVEL', unit: 'km', factorValue: 0.115, category: 'TRANSPORT', scope: 'Scope 3' },
    { name: 'Hotel stays', activityType: 'HOTEL', unit: 'nights', factorValue: 15, category: 'HOTEL', scope: 'Scope 3' },
    {
      id: 'pilot-ground-transport-canada-2025',
      name: 'Ground Transport - Canada - 2025',
      activityType: 'GROUND_TRANSPORT',
      unit: 'km',
      factorValue: 0.2,
      jurisdiction: 'Canada - National',
      sourceYear: 2025,
      category: 'TRANSPORT',
      scope: 'Scope 3',
      notes:
        'Pilot estimate for taxi, rideshare, rental car, mileage, and local business travel distance. Internal review required before formal reporting.',
    },
    { name: 'Shipping', activityType: 'SHIPPING', unit: 'ton-km', factorValue: 0.09, category: 'SHIPPING', scope: 'Scope 3' },
    {
      name: 'Water usage tracked only',
      activityType: 'WATER',
      unit: 'm3',
      factorValue: 0,
      category: 'WATER',
      scope: null,
      notes: 'Tracked-only demo entry. No emissions factor should be assumed unless a reporting methodology requires one.',
    },
  ] as const;

  for (const factor of defaultFactors) {
    const metadata = getSystemFactorMetadata(factor.activityType);
    const factorJurisdiction = 'jurisdiction' in factor && factor.jurisdiction
      ? factor.jurisdiction
      : metadata.jurisdiction;
    const factorRegionKey = factorJurisdiction
      .toLowerCase()
      .replace(/\(generic\)/g, 'generic')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const existingFactor = await prisma.conversionFactor.findFirst({
      where: {
        isSystemDefault: true,
        type: 'EMISSION',
        activityType: factor.activityType,
        unit: factor.unit,
        jurisdiction: factorJurisdiction,
      },
    });

    const governanceData = {
      jurisdiction: factorJurisdiction,
      country: 'Canada',
      sourceAuthority: metadata.sourceAuthority,
      sourceDocument: metadata.sourceDocument,
      sourceYear: 'sourceYear' in factor && factor.sourceYear ? factor.sourceYear : metadata.sourceYear,
      sourceUrl: metadata.sourceUrl,
      sourceName: metadata.sourceAuthority,
      sourceReference: metadata.sourceDocument,
      methodology: metadata.methodology,
      confidenceLevel: metadata.confidenceLevel,
      verificationStatus: metadata.verificationStatus,
      verified: metadata.verified,
      notes: metadata.notes,
    };

    if (existingFactor) {
      await prisma.conversionFactor.update({
        where: { id: existingFactor.id },
        data: {
          name: factor.name,
          ...governanceData,
        },
      });
    } else {
      await prisma.conversionFactor.create({
        data: {
          id: 'id' in factor ? factor.id : undefined,
          organizationId: null,
          name: factor.name,
          type: 'EMISSION',
          activityType: factor.activityType,
          unit: factor.unit,
          factorValue: factor.factorValue,
          resultUnit: 'kgCO2e',
          isDefault: true,
          isSystemDefault: true,
          ...governanceData,
        },
      });
    }

    const sourceId = `system-source-${factor.activityType}-${factor.unit}-${governanceData.sourceYear}-${factorRegionKey}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const factorId = `demo-factor-${factor.activityType}-${factorRegionKey}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const version = `demo-${governanceData.sourceYear}-${factor.unit}-${factorRegionKey}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');

    await prisma.factorSource.upsert({
      where: { id: sourceId },
      update: {
        sourceAuthority: governanceData.sourceAuthority,
        sourceShortName: 'CarbonLite',
        sourceDocument: governanceData.sourceDocument,
        sourceVersion: 'v1.0',
        sourceYear: governanceData.sourceYear,
        sourceUrl: metadata.sourceUrl,
        page: '',
        tableReference: '',
        publishedDate: new Date('2025-01-01T00:00:00.000Z'),
        country: 'Canada',
        jurisdictionRegion: factorJurisdiction,
        publisherType: 'CUSTOM',
        description: 'CarbonLite MVP system factor metadata for pilot workflow validation.',
        notes: governanceData.notes,
        isOfficial: false,
        isActive: true,
      },
      create: {
        id: sourceId,
        sourceAuthority: governanceData.sourceAuthority,
        sourceShortName: 'CarbonLite',
        sourceDocument: governanceData.sourceDocument,
        sourceVersion: 'v1.0',
        sourceYear: governanceData.sourceYear,
        sourceUrl: metadata.sourceUrl,
        page: '',
        tableReference: '',
        publishedDate: new Date('2025-01-01T00:00:00.000Z'),
        country: 'Canada',
        jurisdictionRegion: factorJurisdiction,
        publisherType: 'CUSTOM',
        description: 'CarbonLite MVP system factor metadata for pilot workflow validation.',
        notes: governanceData.notes,
        isOfficial: false,
        isActive: true,
      },
    });

    await prisma.factor.upsert({
      where: { id: factorId },
      update: {
        displayName: factor.name,
        category: 'category' in factor ? factor.category : 'OTHER',
        scope: 'scope' in factor ? factor.scope : null,
        description: governanceData.notes,
        isSystem: true,
        isActive: true,
      },
      create: {
        id: factorId,
        activityType: factor.activityType,
        displayName: factor.name,
        category: 'category' in factor ? factor.category : 'OTHER',
        scope: 'scope' in factor ? factor.scope : null,
        description: governanceData.notes,
        isSystem: true,
        isActive: true,
      },
    });

    await prisma.factorVersion.upsert({
      where: {
        factorId_version: {
          factorId,
          version,
        },
      },
      update: {
        factorValue: factor.factorValue,
        inputUnit: factor.unit,
        resultUnit: 'kgCO2e',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: factorJurisdiction,
        factorYear: governanceData.sourceYear,
        status: 'DRAFT',
        confidenceLevel: 'DEMO',
        methodology: metadata.methodology,
        verificationStatus: metadata.verificationStatus,
        verified: metadata.verified,
        reviewNotes: 'Internal review required before production use.',
        sourceId,
        notes: governanceData.notes,
      },
      create: {
        factorId,
        version,
        factorValue: factor.factorValue,
        inputUnit: factor.unit,
        resultUnit: 'kgCO2e',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: factorJurisdiction,
        factorYear: governanceData.sourceYear,
        status: 'DRAFT',
        confidenceLevel: 'DEMO',
        methodology: metadata.methodology,
        verificationStatus: metadata.verificationStatus,
        verified: metadata.verified,
        reviewNotes: 'Internal review required before production use.',
        sourceId,
        notes: governanceData.notes,
      },
    });
  }

  await prisma.conversionFactor.updateMany({
    where: {
      isSystemDefault: true,
      activityType: 'ELECTRICITY',
      unit: 'kWh',
      jurisdiction: 'Province Required',
    },
    data: {
      name: 'Electricity - Province Required',
      country: 'Canada',
      confidenceLevel: systemFactorMetadata.electricity.confidenceLevel,
      verificationStatus: systemFactorMetadata.electricity.verificationStatus,
      verified: false,
      notes: systemFactorMetadata.electricity.notes,
    },
  });

  await prisma.factor.updateMany({
    where: {
      id: 'demo-factor-electricity',
      activityType: 'ELECTRICITY',
    },
    data: {
      displayName: 'Electricity - Province Required',
      description: systemFactorMetadata.electricity.notes,
      isSystem: true,
      isActive: true,
    },
  });

  await prisma.factorVersion.updateMany({
    where: {
      factorId: 'demo-factor-electricity',
      jurisdictionRegion: 'Province Required',
    },
    data: {
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'Province Required',
      status: 'DRAFT',
      confidenceLevel: 'DEMO',
      verificationStatus: systemFactorMetadata.electricity.verificationStatus,
      verified: false,
      notes: systemFactorMetadata.electricity.notes,
    },
  });

  console.log('✅ System conversion factors and Factor Library demo versions ready');

  const existingActivity = await prisma.activityData.findFirst({
    where: {
      organizationId: org.id,
      sourceReference: 'seed-demo',
    },
  });

  const activity =
    existingActivity ??
    (await prisma.activityData.create({
      data: {
        organizationId: org.id,
        activityType: 'DIESEL',
        recordDate: new Date(),
        quantity: 100,
        unit: 'liters',
        sourceType: 'MANUAL',
        sourceReference: 'seed-demo',
        notes: 'Seed demo data',
      },
    }));

  console.log('✅ Activity data ready:', activity.id);

  console.log('🎉 Seed completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
