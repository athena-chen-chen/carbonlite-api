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
    ['Diesel emission factor', 'DIESEL', 'liters', 2.68],
    ['Gasoline emission factor', 'GASOLINE', 'liters', 2.31],
    ['Natural gas emission factor', 'NATURAL_GAS', 'm3', 1.89],
    ['Electricity emission factor', 'ELECTRICITY', 'kWh', 0.53],
    ['Air travel emission factor', 'AIR_TRAVEL', 'km', 0.115],
    ['Hotel emission factor', 'HOTEL', 'nights', 15],
    ['Shipping emission factor', 'SHIPPING', 'ton-km', 0.09],
  ] as const;

  for (const [name, activityType, unit, factorValue] of defaultFactors) {
    const existingFactor = await prisma.conversionFactor.findFirst({
      where: {
        isSystemDefault: true,
        type: 'EMISSION',
        activityType,
        unit,
      },
    });

    if (!existingFactor) {
      await prisma.conversionFactor.create({
        data: {
          organizationId: null,
          name,
          type: 'EMISSION',
          activityType,
          unit,
          factorValue,
          resultUnit: 'kgCO2e',
          sourceName: 'CarbonLite system defaults',
          sourceReference: 'seed-script',
          isDefault: true,
          isSystemDefault: true,
        },
      });
    }
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
