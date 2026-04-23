import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

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

  const existingFactor = await prisma.conversionFactor.findFirst({
    where: {
      organizationId: org.id,
      name: 'Diesel emission factor',
      activityType: 'DIESEL',
      unit: 'liters',
      resultUnit: 'kgCO2e',
    },
  });

  const factor =
    existingFactor ??
    (await prisma.conversionFactor.create({
      data: {
        organizationId: org.id,
        name: 'Diesel emission factor',
        type: 'EMISSION',
        activityType: 'DIESEL',
        unit: 'liters',
        factorValue: 2.68,
        resultUnit: 'kgCO2e',
        sourceName: 'Default seed',
        sourceReference: 'seed-script',
        isDefault: true,
      },
    }));

  console.log('✅ Conversion factor ready:', factor.id);

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