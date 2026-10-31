import { PrismaClient } from '@prisma/client';
import {
  assertProductionFactorLoadAllowed,
  databaseTargetSummary,
  formatProductionFactorVerification,
  loadProductionFactors,
  verifyProductionFactors,
} from '../prisma/library/production-factor-deployment.ts';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

try {
  const target = dryRun
    ? databaseTargetSummary(process.env)
    : assertProductionFactorLoadAllowed(process.env);
  console.log(JSON.stringify({ operation: dryRun ? 'DRY_RUN' : 'LOAD', target }));
  if (dryRun) {
    const result = await verifyProductionFactors(prisma);
    console.log(formatProductionFactorVerification(result));
    console.log(`Dry run: ${result.missing.length} expected factors would be created; invalid existing records require review.`);
  } else {
    const { verification } = await loadProductionFactors(prisma, process.env);
    console.log(formatProductionFactorVerification(verification));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
