import { PrismaClient } from '@prisma/client';
import {
  databaseTargetSummary,
  formatProductionFactorVerification,
  verifyProductionFactors,
} from '../prisma/library/production-factor-deployment.ts';

const prisma = new PrismaClient();
try {
  console.log(JSON.stringify({ operation: 'VERIFY', target: databaseTargetSummary(process.env) }));
  const result = await verifyProductionFactors(prisma);
  console.log(formatProductionFactorVerification(result));
  if (!result.pass) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
