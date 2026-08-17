import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  GOLDEN_SAMPLE_DATASET_KEY,
  GOLDEN_SAMPLE_WORKSPACE_NAME,
  ensureGoldenSampleDataForWorkspace,
} from '../src/sample-data/golden-sample-data.service';

const prisma = new PrismaClient();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceName = args.workspace || GOLDEN_SAMPLE_WORKSPACE_NAME;

  const workspace = await findOrCreateWorkspace(workspaceName);
  const result = await ensureGoldenSampleDataForWorkspace(
    prisma,
    workspace.id,
    { force: args.force },
  );

  if (result.alreadySeeded) {
    console.log(
      'Golden sample data already exists for this workspace. No duplicate records created.',
    );
  } else {
    console.log('Golden sample data ensured successfully.');
  }

  console.log('');
  console.log(`Workspace: ${workspace.name}`);
  console.log(`Dataset: ${GOLDEN_SAMPLE_DATASET_KEY}`);
  console.log(`Records seeded: ${result.recordsSeeded}`);
  console.log(`Included GHG records: ${result.includedGhgRecords}`);
  console.log(
    `Tracked operational metrics: ${result.trackedOperationalMetrics}`,
  );
  console.log(`Records requiring review: ${result.recordsRequiringReview}`);
  console.log(
    `Total calculated emissions: ${result.totalCalculatedEmissions.toLocaleString()} kgCO2e`,
  );
  console.log(`Scope 1: ${result.scope1.toLocaleString()} kgCO2e`);
  console.log(`Scope 2: ${result.scope2.toLocaleString()} kgCO2e`);
  console.log(`Scope 3: ${result.scope3.toLocaleString()} kgCO2e`);
}

async function findOrCreateWorkspace(name: string) {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) return existing;

  return prisma.organization.create({
    data: {
      name,
      slug: await createUniqueSlug(name),
      allowDemoFactorsForCalculations: true,
    },
  });
}

async function createUniqueSlug(name: string) {
  const baseSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'sample-workspace';
  let slug = baseSlug;
  let suffix = 1;

  while (await prisma.organization.findUnique({ where: { slug } })) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  return slug;
}

function parseArgs(args: string[]) {
  const parsed = {
    workspace: '',
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') {
      parsed.force = true;
      continue;
    }

    if (arg === '--workspace') {
      parsed.workspace = args[index + 1]?.trim() ?? '';
      index += 1;
      continue;
    }

    if (arg.startsWith('--workspace=')) {
      parsed.workspace = arg.slice('--workspace='.length).trim();
    }
  }

  return parsed;
}

main()
  .catch((error) => {
    console.error('Failed to seed the CarbonLite sample workspace.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
