/* global console, process */
import { PrismaClient } from '@prisma/client';
import { loadEnvironment } from './dev-database.mjs';
import {
  assertNaturalGasDevelopmentTarget,
  seedEcccNaturalGasAlberta2026,
} from '../prisma/library/eccc-natural-gas-alberta-2026.ts';

async function main() {
  const { env, summary } = loadEnvironment('neon');
  const flag = '--confirmed-development-endpoint=';
  const confirmedEndpoint = process.argv.slice(2).find(arg => arg.startsWith(flag))?.slice(flag.length);
  const volumeOnly = process.argv.includes('--volume-only');
  assertNaturalGasDevelopmentTarget(env, confirmedEndpoint);
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const result = await seedEcccNaturalGasAlberta2026(prisma, { volumeOnly });
    console.log(JSON.stringify({ target: summary, mode: volumeOnly ? 'volume-only' : 'full', ...result }));
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
    error?.message?.startsWith('Refusing data load:') ||
    safeCollision
      ? error.message
      : `Production factor load failed (${error?.code ?? 'configuration or connection error'}).`,
  );
  process.exitCode = 1;
});
