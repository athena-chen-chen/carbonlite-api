/* global console, process */
import { PrismaClient } from '@prisma/client';
import { loadEnvironment } from './dev-database.mjs';
import {
  assertEpaAirTravelDevelopmentTarget,
  seedEpaAirTravel2025,
} from '../prisma/library/epa-air-travel-2025.ts';

async function main() {
  const { env, summary } = loadEnvironment('neon');
  const flag = '--confirmed-development-endpoint=';
  const confirmedEndpoint = process.argv.slice(2).find(arg => arg.startsWith(flag))?.slice(flag.length);
  assertEpaAirTravelDevelopmentTarget(env, confirmedEndpoint);
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const result = await seedEpaAirTravel2025(prisma);
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
    error?.message?.startsWith('Refusing data load:') || safeCollision
      ? error.message
      : `Production factor load failed (${error?.code ?? 'configuration or connection error'}).`,
  );
  process.exitCode = 1;
});
