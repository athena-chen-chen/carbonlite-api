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

  const defaultFactors = [
    { name: 'Diesel emission factor', activityType: 'DIESEL', unit: 'liters', factorValue: 2.68 },
    { name: 'Gasoline emission factor', activityType: 'GASOLINE', unit: 'liters', factorValue: 2.31 },
    { name: 'Natural gas emission factor', activityType: 'NATURAL_GAS', unit: 'm3', factorValue: 1.89 },
    {
      name: 'Electricity - Alberta - 2025',
      activityType: 'ELECTRICITY',
      unit: 'kWh',
      factorValue: 0.53,
      jurisdiction: 'Alberta, Canada',
      sourceYear: 2025,
      notes:
        'Electricity factors vary by province and reporting year. Replace with a verified jurisdiction-specific factor before client or regulatory reporting.',
    },
    { name: 'Air travel emission factor', activityType: 'AIR_TRAVEL', unit: 'km', factorValue: 0.115 },
    { name: 'Hotel emission factor', activityType: 'HOTEL', unit: 'nights', factorValue: 15 },
    { name: 'Shipping emission factor', activityType: 'SHIPPING', unit: 'ton-km', factorValue: 0.09 },
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

    if (existingFactor) {
      await prisma.conversionFactor.update({
        where: { id: existingFactor.id },
        data: {
          name: factor.name,
          ...governanceData,
        },
      });
      continue;
    }

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

  console.log('✅ System conversion factors ready');

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
