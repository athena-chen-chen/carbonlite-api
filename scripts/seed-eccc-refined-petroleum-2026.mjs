/* global console, process */
import { PrismaClient } from '@prisma/client';
import { loadEnvironment } from './dev-database.mjs';
import { seedEcccRefinedPetroleum2026 } from '../prisma/library/eccc-refined-petroleum-2026.ts';

async function main() {
  const { env, summary } = loadEnvironment('localdb');
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const result = await seedEcccRefinedPetroleum2026(prisma);
    console.log(JSON.stringify({ target: summary, ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const safeCollision = String(error?.message ?? '').startsWith(
    'A different record already uses the production factor name:',
  );
  console.error(
    error?.message?.startsWith('Refusing') ||
    error?.message?.startsWith('Local mode requires') ||
    safeCollision
      ? error.message
      : `Production factor load failed (${error?.code ?? 'configuration or connection error'}).`,
  );
  process.exitCode = 1;
});
