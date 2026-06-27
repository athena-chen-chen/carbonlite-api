import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
      jurisdiction: 'Alberta, Canada',
      sourceYear: 2025,
      category: 'ELECTRICITY',
      scope: 'Scope 2',
      notes:
        'Electricity factors vary by province and reporting year. Replace with a verified jurisdiction-specific factor before client or regulatory reporting.',
    },
    { name: 'Air travel', activityType: 'AIR_TRAVEL', unit: 'km', factorValue: 0.115, category: 'TRANSPORT', scope: 'Scope 3' },
    { name: 'Hotel stays', activityType: 'HOTEL', unit: 'nights', factorValue: 15, category: 'HOTEL', scope: 'Scope 3' },
    { name: 'Shipping', activityType: 'SHIPPING', unit: 'ton-km', factorValue: 0.09, category: 'SHIPPING', scope: 'Scope 3' },
    {
      name: 'Electricity - British Columbia',
      activityType: 'ELECTRICITY',
      unit: 'kWh',
      factorValue: 0.02,
      jurisdiction: 'British Columbia, Canada',
      sourceYear: 2025,
      category: 'ELECTRICITY',
      scope: 'Scope 2',
      notes:
        'Demo electricity factor for workflow testing. Replace with verified jurisdiction-specific factors before client or regulatory reporting.',
    },
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
    const existingFactor = await prisma.conversionFactor.findFirst({
      where: {
        isSystemDefault: true,
        type: 'EMISSION',
        activityType: factor.activityType,
        unit: factor.unit,
      },
    });

    const governanceData = {
      jurisdiction: 'jurisdiction' in factor ? factor.jurisdiction : 'Canada',
      sourceAuthority: 'Demo / Placeholder',
      sourceDocument: 'Pilot default factor library',
      sourceYear: 'sourceYear' in factor ? factor.sourceYear : null,
      sourceName: 'Demo / Placeholder',
      sourceReference: 'Pilot default factor library',
      verified: false,
      notes:
        'notes' in factor
          ? factor.notes
          : 'Pilot workflow factor. Verify the applicable authority, jurisdiction, and reporting year before final reporting.',
    };

    if (factor.activityType !== 'WATER') {
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
    }

    const sourceId = `demo-source-${factor.activityType}-${factor.unit}-${'sourceYear' in factor ? factor.sourceYear ?? 'na' : 'na'}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const factorId = `demo-factor-${factor.activityType}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const version = `demo-${'sourceYear' in factor && factor.sourceYear ? factor.sourceYear : 'v1'}-${factor.unit}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');

    await prisma.factorSource.upsert({
      where: { id: sourceId },
      update: {
        sourceAuthority: governanceData.sourceAuthority,
        sourceShortName: 'Demo',
        sourceDocument: governanceData.sourceDocument,
        sourceVersion: 'pilot-demo',
        sourceYear: governanceData.sourceYear ?? 0,
        sourceUrl: '',
        page: '',
        tableReference: '',
        publishedDate: new Date(),
        country: 'Canada',
        jurisdictionRegion: 'jurisdiction' in factor ? factor.jurisdiction : 'Canada',
        publisherType: 'UNKNOWN',
        description: 'CarbonLite pilot demo source used for workflow validation.',
        notes: governanceData.notes,
        isOfficial: false,
        isActive: true,
      },
      create: {
        id: sourceId,
        sourceAuthority: governanceData.sourceAuthority,
        sourceShortName: 'Demo',
        sourceDocument: governanceData.sourceDocument,
        sourceVersion: 'pilot-demo',
        sourceYear: governanceData.sourceYear ?? 0,
        sourceUrl: '',
        page: '',
        tableReference: '',
        publishedDate: new Date(),
        country: 'Canada',
        jurisdictionRegion: 'jurisdiction' in factor ? factor.jurisdiction : 'Canada',
        publisherType: 'UNKNOWN',
        description: 'CarbonLite pilot demo source used for workflow validation.',
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
        resultUnit: factor.activityType === 'WATER' ? 'tracked' : 'kgCO2e',
        jurisdictionCountry: 'country' in factor ? factor.country ?? null : 'Canada',
        jurisdictionRegion: 'jurisdiction' in factor ? factor.jurisdiction : 'Canada',
        factorYear: 'sourceYear' in factor ? factor.sourceYear ?? null : null,
        status: 'DRAFT',
        confidenceLevel: 'DEMO',
        sourceId,
        notes: governanceData.notes,
      },
      create: {
        factorId,
        version,
        factorValue: factor.factorValue,
        inputUnit: factor.unit,
        resultUnit: factor.activityType === 'WATER' ? 'tracked' : 'kgCO2e',
        jurisdictionCountry: 'country' in factor ? factor.country ?? null : 'Canada',
        jurisdictionRegion: 'jurisdiction' in factor ? factor.jurisdiction : 'Canada',
        factorYear: 'sourceYear' in factor ? factor.sourceYear ?? null : null,
        status: 'DRAFT',
        confidenceLevel: 'DEMO',
        sourceId,
        notes: governanceData.notes,
      },
    });
  }

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
